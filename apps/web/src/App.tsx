import type {
  ActorId,
  AgentViewSnapshot,
  Command,
  CommandId,
  Decision,
  FromWorker,
  Machine,
  MachineId,
  RenderFrame,
  TickerEntry,
} from "@crew/sim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSimConnection } from "./host/connection";
import { FramePlayback, runPlaybackLoop } from "./host/playback";
import { clearLocalSave, readLocalSave, writeLocalSave } from "./host/saves";
import { DeckCanvas, type Selection } from "./render/DeckCanvas";
import { buildDeckLayout } from "./render/deckLayout";
import { DecisionModal, DecisionPill } from "./ui/DecisionModal";
import { Inspector, type InspectorData } from "./ui/Inspector";
import { NarratorOverlay } from "./ui/NarratorOverlay";
import { Ticker } from "./ui/Ticker";
import { TopBar } from "./ui/TopBar";
import { loadWebContent } from "./worker/content";

type HealthState = "checking" | "ok" | "error";

const TICKER_LIMIT = 6;

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req:${requestCounter}`;
}

let commandCounter = 0;
function nextCommandId(): CommandId {
  commandCounter += 1;
  return `cmd:player:${commandCounter}` as CommandId;
}

export function App() {
  // Loaded once, synchronously: same authored bundle the worker validates and loads (task item
  // 4). Only used here for the static deck layout and the tick rate the playback loop paces to.
  const { bundle, config, scenarioId } = useMemo(() => loadWebContent(), []);
  const tickRate = config.values.time.tickRate;
  const saveEveryTicks = tickRate * 15;
  const deck = useMemo(() => {
    const scenario = bundle.scenarios[scenarioId];
    const deckDef = scenario ? bundle.decks[scenario.deckId] : undefined;
    if (deckDef === undefined) {
      throw new Error(`No deck for scenario "${scenarioId}"`);
    }
    return deckDef;
  }, [bundle, scenarioId]);
  const layout = useMemo(() => buildDeckLayout(deck, bundle), [deck, bundle]);

  const connectionRef = useRef<ReturnType<typeof createSimConnection> | undefined>(undefined);
  const playbackRef = useRef(new FramePlayback(tickRate));
  const pendingRequests = useRef(new Map<string, (message: FromWorker) => void>());
  const lastSaveTickRef = useRef(0);

  const [frame, setFrame] = useState<RenderFrame>();
  const [speed, setSpeedState] = useState(1);
  const [paused, setPausedState] = useState(false);
  const [runAhead, setRunAhead] = useState({ simTick: 0, viewTick: 0, buffered: 0 });
  const [ticker, setTicker] = useState<TickerEntry[]>([]);
  const [selection, setSelection] = useState<Selection>();
  const [inspectorData, setInspectorData] = useState<InspectorData>();
  const [thinking, setThinking] = useState(false);
  const [decision, setDecision] = useState<Decision>();
  const [decisionHidden, setDecisionHidden] = useState(false);
  const [health, setHealth] = useState<HealthState>("checking");

  // -------------------------------------------------------------- API health dot
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { ok: boolean }) => {
        if (!cancelled) setHealth(body.ok ? "ok" : "error");
      })
      .catch(() => {
        if (!cancelled) setHealth("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------- worker connection + playback
  useEffect(() => {
    const connection = createSimConnection();
    connectionRef.current = connection;
    const playback = playbackRef.current;

    const unsubscribe = connection.subscribe((message) => {
      const requestId = "requestId" in message ? message.requestId : undefined;
      if (requestId && pendingRequests.current.has(requestId)) {
        pendingRequests.current.get(requestId)?.(message);
        pendingRequests.current.delete(requestId);
        return;
      }
      switch (message.type) {
        case "frame": {
          playback.push(message.frame);
          // A frame only arrives once the kernel is running again, so this also covers the
          // quiet-too-long hook (and any other hook) resolving with no decision surfaced: the
          // overlay clears as soon as the sim resumes producing frames.
          setThinking(false);
          if (message.frame.tickerEvents.length > 0) {
            setTicker((prev) =>
              [...message.frame.tickerEvents].reverse().concat(prev).slice(0, TICKER_LIMIT),
            );
          }
          if (message.frame.tick - lastSaveTickRef.current >= saveEveryTicks) {
            lastSaveTickRef.current = message.frame.tick;
            requestSave(connection);
          }
          return;
        }
        case "runAheadStatus":
          setRunAhead({
            simTick: message.simTick,
            viewTick: message.viewTick ?? 0,
            buffered: message.buffered,
          });
          return;
        case "hookRaised":
          setThinking(true);
          return;
        case "decisionPending":
          setThinking(false);
          setDecision(message.decision);
          setDecisionHidden(false);
          // Save on every decision (task brief).
          requestSave(connection);
          return;
        case "error":
          // Requests correlated by `requestId` are handled above; an uncorrelated error is the
          // worker's own recovery, currently just "the save was incompatible" (host.ts's `load`
          // handler already started a new game) — clear the stale save so the next reload
          // doesn't retry it.
          console.warn("[sim worker]", message.message);
          void clearLocalSave();
          return;
        default:
          return;
      }
    });

    function requestSave(conn: ReturnType<typeof createSimConnection>): void {
      const requestId = nextRequestId();
      pendingRequests.current.set(requestId, (msg) => {
        if (msg.type === "saveBlob") void writeLocalSave(msg.envelope);
      });
      conn.send({ type: "requestSave", requestId });
    }

    const loop = runPlaybackLoop(
      playback,
      (step) => setFrame(step.frame),
      (viewTick) => connection.send({ type: "viewProgress", viewTick }),
    );

    void readLocalSave().then((save) => {
      if (save) {
        connection.send({ type: "load", source: { kind: "save", envelope: save } });
      } else {
        connection.send({
          type: "load",
          source: {
            kind: "scenario",
            scenarioId,
            seed: Math.floor(Math.random() * 1_000_000),
          },
        });
      }
    });

    return () => {
      loop.stop();
      unsubscribe();
      connection.dispose();
    };
    // `scenarioId`/`saveEveryTicks` come from the content bundle loaded once via `useMemo(() =>
    // loadWebContent(), [])` above, so they never change across this component's lifetime.
  }, [scenarioId, saveEveryTicks]);

  // -------------------------------------------------------------- speed / pause
  const onSetSpeed = useCallback((next: number) => {
    setSpeedState(next);
    setPausedState(false);
    playbackRef.current.setSpeed(next);
    connectionRef.current?.setUserPaused(false);
    connectionRef.current?.send({ type: "setSpeed", speed: next });
    connectionRef.current?.send({ type: "resume" });
  }, []);

  const onTogglePause = useCallback(() => {
    setPausedState((prev) => {
      const next = !prev;
      connectionRef.current?.setUserPaused(next);
      connectionRef.current?.send({ type: next ? "pause" : "resume" });
      return next;
    });
  }, []);

  // -------------------------------------------------------------- inspector
  const onSelect = useCallback(
    (next: Selection | undefined) => {
      setSelection(next);
      if (!next) {
        setInspectorData(undefined);
        return;
      }
      setInspectorData({ kind: "loading" });
      const connection = connectionRef.current;
      if (!connection) return;
      const viewTick = runAhead.viewTick || frame?.tick || 0;
      const requestId = nextRequestId();
      if (next.kind === "actor") {
        pendingRequests.current.set(requestId, (msg) => {
          if (msg.type === "agentViewResult") {
            setInspectorData({ kind: "actor", view: msg.view as AgentViewSnapshot });
          } else if (msg.type === "error") {
            setInspectorData(undefined);
          }
        });
        connection.send({
          type: "requestAgentView",
          requestId,
          actorId: next.id as ActorId,
          tick: viewTick,
        });
      } else {
        pendingRequests.current.set(requestId, (msg) => {
          if (msg.type === "snapshot") {
            const machine = msg.state.machines[next.id as MachineId] as Machine | undefined;
            if (machine) setInspectorData({ kind: "machine", machine });
            else setInspectorData(undefined);
          } else if (msg.type === "error") {
            setInspectorData(undefined);
          }
        });
        connection.send({ type: "requestSnapshotAt", requestId, tick: viewTick });
      }
    },
    [frame, runAhead.viewTick],
  );

  const onCloseInspector = useCallback(() => {
    setSelection(undefined);
    setInspectorData(undefined);
  }, []);

  // -------------------------------------------------------------- decisions
  const onChooseDecision = useCallback(
    (side: "left" | "right") => {
      const connection = connectionRef.current;
      if (!connection || !decision) return;
      const requestId = nextRequestId();
      const command: Command = {
        id: nextCommandId(),
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: decision.id, side },
      };
      connection.send({ type: "command", requestId, command });
      setDecision(undefined);
      setDecisionHidden(false);
    },
    [decision],
  );

  const money = frame?.money ?? 0;
  const travelState = frame?.travel.state ?? "docked";
  const runAheadSeconds = runAhead.buffered / tickRate;

  return (
    <div className="app">
      <TopBar
        speed={speed}
        paused={paused}
        onSetSpeed={onSetSpeed}
        onTogglePause={onTogglePause}
        simTick={frame?.tick ?? 0}
        tickRate={tickRate}
        money={money}
        travelState={travelState}
        runAheadBufferedSeconds={runAheadSeconds}
        health={health}
      />
      <div className="main-area">
        <DeckCanvas layout={layout} frame={frame} selected={selection} onSelect={onSelect} />
        <Ticker entries={ticker} />
      </div>
      <Inspector data={inspectorData} onClose={onCloseInspector} />
      {thinking && <NarratorOverlay />}
      {decision && !decisionHidden && !thinking && (
        <DecisionModal
          decision={decision}
          onChoose={onChooseDecision}
          onInspect={() => setDecisionHidden(true)}
        />
      )}
      {decision && decisionHidden && <DecisionPill onClick={() => setDecisionHidden(false)} />}
      <button
        type="button"
        className="new-game-button"
        onClick={() => {
          void clearLocalSave().then(() => window.location.reload());
        }}
      >
        New game
      </button>
    </div>
  );
}
