import { type DecisionCardText, templateCard } from "@crew/content";
import type {
  ActorId,
  AgentViewSnapshot,
  Command,
  CommandId,
  Decision,
  FromWorker,
  ItemId,
  Machine,
  MachineId,
  NarratorHook,
  RenderFrame,
  SaveEnvelope,
  SimEvent,
  Tick,
  TickerEntry,
} from "@crew/sim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SimConnection, createSimConnection } from "./host/connection";
import {
  type NarratorOutcome,
  appendRecentEvents,
  callNarrator,
  hookAnswer,
} from "./host/narrator";
import { FramePlayback, runPlaybackLoop } from "./host/playback";
import {
  ServerSaves,
  clearLocalSave,
  forgetServerGame,
  newerSave,
  openServerGame,
  readLocalSave,
  writeLocalSave,
} from "./host/saves";
import { DeckCanvas, type Selection } from "./render/DeckCanvas";
import { buildDeckLayout } from "./render/deckLayout";
import { DecisionModal, DecisionPill } from "./ui/DecisionModal";
import { Headline } from "./ui/Headline";
import { Inspector, type InspectorData } from "./ui/Inspector";
import { NarratorOverlay } from "./ui/NarratorOverlay";
import { Ticker } from "./ui/Ticker";
import { Toast } from "./ui/Toast";
import { TopBar } from "./ui/TopBar";
import { TravelBar } from "./ui/TravelBar";
import { AFTERMATH_MS, aftermathCaption } from "./ui/aftermath";
import { inspectItem } from "./ui/itemInspection";
import { rejectionMessage } from "./ui/rejectionMessage";
import { loadWebContent } from "./worker/content";

type HealthState = "checking" | "ok" | "error";

const TICKER_LIMIT = 6;
/** Wall-clock cadence of routine server saves (PLAN §3: "Neon every ~60 s"). */
const REMOTE_SAVE_EVERY_MS = 60_000;
/** How long startup waits for the server before loading the local save on its own. */
const SERVER_OPEN_GRACE_MS = 3_000;
const TOAST_MS = 4_000;
const NARRATOR_UNAVAILABLE = "Narrator unavailable — carrying on";

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req:${requestCounter}`;
}

let commandCounter = 0;
function nextCommandId(): CommandId {
  commandCounter += 1;
  return `cmd:player:${Date.now().toString(36)}:${commandCounter}` as CommandId;
}

interface PendingHook {
  readonly hookId: NarratorHook["id"];
  readonly tick: Tick;
}

export function App() {
  // Loaded once, synchronously: same authored bundle the worker validates and loads. Used here
  // for the static deck layout, card templates, names and the tick rate playback paces to.
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

  const connectionRef = useRef<SimConnection | undefined>(undefined);
  const playbackRef = useRef(new FramePlayback(tickRate));
  const pendingRequests = useRef(new Map<string, (message: FromWorker) => void>());
  /** D42: player commands in flight, by request id, so a rejection can be shown as a toast. */
  const playerCommands = useRef(new Map<string, Command["kind"]>());
  const lastSaveTickRef = useRef(0);
  const serverRef = useRef<ServerSaves | undefined>(undefined);
  const recentEventsRef = useRef<SimEvent[]>([]);
  const staleRef = useRef(false);
  const pausedRef = useRef(false);

  const [frame, setFrame] = useState<RenderFrame>();
  const [speed, setSpeedState] = useState(1);
  const [paused, setPausedState] = useState(false);
  const [runAhead, setRunAhead] = useState({ simTick: 0, viewTick: 0, buffered: 0 });
  const [ticker, setTicker] = useState<TickerEntry[]>([]);
  const [selection, setSelection] = useState<Selection>();
  const [inspectorData, setInspectorData] = useState<InspectorData>();
  const [pendingHook, setPendingHook] = useState<PendingHook>();
  const [decision, setDecision] = useState<Decision>();
  const [decisionHidden, setDecisionHidden] = useState(false);
  const [prose, setProse] = useState<Readonly<Record<string, DecisionCardText>>>({});
  const [health, setHealth] = useState<HealthState>("checking");
  const [toast, setToast] = useState<string>();
  const [stale, setStale] = useState(false);
  /** D26: the card just answered, kept up with its aftermath caption until the timer closes it. */
  const [closingCard, setClosingCard] = useState<{
    readonly card: DecisionCardText;
    readonly side: "left" | "right";
    readonly caption: string;
  }>();
  const closingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closingTimer.current), []);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), TOAST_MS);
  }, []);

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
    let disposed = false;

    /** Ask the worker for a save envelope (the current, possibly run-ahead, state). */
    function requestEnvelope(): Promise<SaveEnvelope> {
      return new Promise((resolve, reject) => {
        const requestId = nextRequestId();
        pendingRequests.current.set(requestId, (msg) => {
          if (msg.type === "saveBlob") resolve(msg.envelope);
          else reject(new Error(msg.type === "error" ? msg.message : `unexpected ${msg.type}`));
        });
        connection.send({ type: "requestSave", requestId });
      });
    }

    /** Local save always (unless another tab owns the game); server save when asked. */
    function save(remote: "none" | "routine" | "milestone"): void {
      if (staleRef.current) return;
      requestEnvelope()
        .then((envelope) => {
          if (staleRef.current) return;
          void writeLocalSave(envelope);
          if (remote !== "none") serverRef.current?.write(envelope, remote === "milestone");
        })
        .catch((error: unknown) => {
          console.warn("[saves] could not get a save from the worker", error);
        });
    }

    function send(command: Command): void {
      const requestId = nextRequestId();
      if (command.source === "player") playerCommands.current.set(requestId, command.kind);
      connection.send({ type: "command", requestId, command });
    }

    /** D5: call the narrator for a hook, apply its answer, and always acknowledge. */
    async function answerHook(hook: NarratorHook, tick: Tick): Promise<void> {
      setPendingHook({ hookId: hook.id, tick });
      let envelope: SaveEnvelope | undefined;
      try {
        envelope = await requestEnvelope();
      } catch (error) {
        console.warn("[narrator] no snapshot for the hook", error);
      }
      const server = serverRef.current;
      let outcome: NarratorOutcome | undefined;
      if (server !== undefined && envelope !== undefined) {
        outcome = await callNarrator({
          gameId: server.gameId,
          token: server.token,
          hook,
          snapshot: envelope,
          recentEvents: recentEventsRef.current.slice(),
        });
      }
      if (disposed) return;
      if (outcome?.ok) {
        recentEventsRef.current.length = 0;
        // D37: a `policyDecision` hook halts before its decision does, so this prose is in the
        // map before `decisionPending` arrives and the modal opens dressed.
        const card = outcome.reply.card;
        if (card !== undefined) setProse((prev) => ({ ...prev, [card.decisionId]: card }));
        for (const command of hookAnswer(hook, tick, outcome.reply)) send(command);
      } else {
        if (outcome !== undefined) console.warn(`[narrator] ${outcome.reason}`);
        showToast(NARRATOR_UNAVAILABLE);
        for (const command of hookAnswer(hook, tick, undefined)) send(command);
        // The narrator route stores the snapshot itself; without it, keep a milestone anyway.
        if (envelope !== undefined && !staleRef.current) {
          void writeLocalSave(envelope);
          serverRef.current?.write(envelope, true);
        }
      }
      setPendingHook(undefined);
    }

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
          if (message.frame.tickerEvents.length > 0) {
            setTicker((prev) =>
              [...message.frame.tickerEvents].reverse().concat(prev).slice(0, TICKER_LIMIT),
            );
          }
          if (message.frame.tick - lastSaveTickRef.current >= saveEveryTicks) {
            lastSaveTickRef.current = message.frame.tick;
            save("none");
          }
          return;
        }
        case "events": {
          appendRecentEvents(recentEventsRef.current, message.events);
          if (message.events.some((e) => e.type === "arrived")) save("milestone");
          else if (message.events.some((e) => e.type === "decisionResolved")) save("routine");
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
          void answerHook(message.hook, message.tick);
          return;
        case "decisionPending":
          setDecision(message.decision);
          setDecisionHidden(false);
          save("none");
          return;
        case "commandResult": {
          const kind = playerCommands.current.get(message.requestId);
          playerCommands.current.delete(message.requestId);
          if (message.result.status === "rejected") {
            console.warn("[sim worker] command rejected", message.result.rejection);
            // D42: a player's own command failing is shown, not just logged.
            if (kind !== undefined) showToast(rejectionMessage(kind, message.result.rejection));
          }
          return;
        }
        case "error":
          // Requests correlated by `requestId` are handled above; an uncorrelated error is the
          // worker's own recovery ("the save was incompatible, started a new game") — clear the
          // stale local save so the next reload doesn't retry it.
          console.warn("[sim worker]", message.message);
          void clearLocalSave();
          return;
        default:
          return;
      }
    });

    const loop = runPlaybackLoop(
      playback,
      (step) => setFrame(step.frame),
      (viewTick) => connection.send({ type: "viewProgress", viewTick }),
    );

    // Startup: open the server game (bounded wait) and load the newer of local and server saves.
    const serverOpen = openServerGame().then((opened) => {
      if (opened === undefined || disposed) return undefined;
      serverRef.current = new ServerSaves(opened.session, {
        onStale: () => {
          staleRef.current = true;
          setStale(true);
        },
      });
      return opened;
    });
    const grace = new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), SERVER_OPEN_GRACE_MS),
    );
    void Promise.all([readLocalSave(), Promise.race([serverOpen, grace])]).then(
      ([local, opened]) => {
        if (disposed) return;
        const chosen = newerSave(local, opened?.headSave);
        if (chosen) {
          connection.send({ type: "load", source: { kind: "save", envelope: chosen } });
        } else {
          connection.send({
            type: "load",
            source: { kind: "scenario", scenarioId, seed: Math.floor(Math.random() * 1_000_000) },
          });
        }
      },
    );

    // Routine server saves on a wall-clock cadence while the game is running and visible.
    const remoteTimer = setInterval(() => {
      if (pausedRef.current || document.visibilityState === "hidden") return;
      if (serverRef.current !== undefined) save("routine");
    }, REMOTE_SAVE_EVERY_MS);

    return () => {
      disposed = true;
      clearInterval(remoteTimer);
      loop.stop();
      unsubscribe();
      connection.dispose();
    };
    // `scenarioId`/`saveEveryTicks` come from the content bundle loaded once, so they never change.
  }, [scenarioId, saveEveryTicks, showToast]);

  // -------------------------------------------------------------- speed / pause
  const onSetSpeed = useCallback((next: number) => {
    setSpeedState(next);
    setPausedState(false);
    pausedRef.current = false;
    playbackRef.current.setSpeed(next);
    connectionRef.current?.setUserPaused(false);
    connectionRef.current?.send({ type: "setSpeed", speed: next });
    connectionRef.current?.send({ type: "resume" });
  }, []);

  const onTogglePause = useCallback(() => {
    setPausedState((prev) => {
      const next = !prev;
      pausedRef.current = next;
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
      const viewTick = frame?.tick ?? runAhead.viewTick;
      const requestId = nextRequestId();
      if (next.kind === "actor") {
        const label = frame?.actors.find((a) => a.id === next.id)?.actionLabel;
        pendingRequests.current.set(requestId, (msg) => {
          if (msg.type === "agentViewResult") {
            setInspectorData({
              kind: "actor",
              view: msg.view as AgentViewSnapshot,
              ...(label === undefined ? {} : { label }),
            });
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
      } else if (next.kind === "item") {
        pendingRequests.current.set(requestId, (msg) => {
          if (msg.type === "snapshot") {
            const item = inspectItem(msg.state, next.id as ItemId, bundle, layout);
            setInspectorData(item === undefined ? undefined : { kind: "item", item });
          } else if (msg.type === "error") {
            setInspectorData(undefined);
          }
        });
        connection.send({ type: "requestSnapshotAt", requestId, tick: viewTick });
      } else {
        pendingRequests.current.set(requestId, (msg) => {
          if (msg.type === "snapshot") {
            const machine = msg.state.machines[next.id as MachineId] as Machine | undefined;
            const name = machine === undefined ? undefined : bundle.machines[machine.defId]?.name;
            if (machine) {
              setInspectorData({
                kind: "machine",
                machine,
                ...(name === undefined ? {} : { name }),
              });
            } else {
              setInspectorData(undefined);
            }
          } else if (msg.type === "error") {
            setInspectorData(undefined);
          }
        });
        connection.send({ type: "requestSnapshotAt", requestId, tick: viewTick });
      }
    },
    [frame, runAhead.viewTick, bundle, layout],
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
      const command: Command = {
        id: nextCommandId(),
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: decision.id, side },
      };
      const requestId = nextRequestId();
      playerCommands.current.set(requestId, command.kind);
      connection.send({ type: "command", requestId, command });
      // D26: keep the answered card up for a moment with a line on what happens next. The sim
      // resumes behind it straight away; only the card lingers.
      const narrated = prose[decision.id];
      setClosingCard({
        card: narrated ?? templateCard(decision, bundle),
        side,
        caption: aftermathCaption(decision, side, narrated, bundle),
      });
      clearTimeout(closingTimer.current);
      closingTimer.current = setTimeout(() => setClosingCard(undefined), AFTERMATH_MS);
      setDecision(undefined);
      setDecisionHidden(false);
    },
    [decision, prose, bundle],
  );

  const onNewGame = useCallback(() => {
    forgetServerGame();
    void clearLocalSave().then(() => window.location.reload());
  }, []);

  const viewTick = frame?.tick ?? 0;
  // D14: the worker may be ahead of the viewer; show hook/decision UI once playback reaches it.
  const thinking = pendingHook !== undefined && viewTick >= pendingHook.tick;
  const decisionDue = decision !== undefined && viewTick >= decision.createdTick;
  const card = useMemo(() => {
    if (decision === undefined) return undefined;
    return prose[decision.id] ?? templateCard(decision, bundle);
  }, [decision, prose, bundle]);

  const money = frame?.money ?? 0;
  const travelState = frame?.travel.state ?? "docked";
  const showCard = card !== undefined && decisionDue && !decisionHidden && !thinking;
  const runAheadSeconds = runAhead.buffered / tickRate;

  return (
    <div className="app">
      <TopBar
        speed={speed}
        paused={paused}
        onSetSpeed={onSetSpeed}
        onTogglePause={onTogglePause}
        simTick={viewTick}
        tickRate={tickRate}
        money={money}
        runAheadBufferedSeconds={runAheadSeconds}
        health={health}
        onNewGame={onNewGame}
      />
      <Headline text={frame?.headline ?? ""} />
      <TravelBar stage={travelState} progress={frame?.travel.progress ?? 0} />
      {stale && (
        <div className="stale-banner" role="alert">
          This game is open in another tab — this tab is no longer saving.
        </div>
      )}
      <div className="main-area">
        <DeckCanvas layout={layout} frame={frame} selected={selection} onSelect={onSelect} />
        <Ticker entries={ticker} />
      </div>
      <Inspector data={inspectorData} onClose={onCloseInspector} />
      {thinking && <NarratorOverlay />}
      {closingCard !== undefined ? (
        <DecisionModal
          card={closingCard.card}
          onChoose={() => undefined}
          onInspect={() => undefined}
          aftermath={{ side: closingCard.side, caption: closingCard.caption }}
        />
      ) : (
        showCard && (
          <DecisionModal
            card={card}
            onChoose={onChooseDecision}
            onInspect={() => setDecisionHidden(true)}
          />
        )
      )}
      {decisionDue && decisionHidden && <DecisionPill onClick={() => setDecisionHidden(false)} />}
      <Toast message={toast} />
    </div>
  );
}
