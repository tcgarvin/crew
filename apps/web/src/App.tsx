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
  ToWorker,
} from "@crew/sim";
import { decisionShownTick } from "@crew/sim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApiHealth } from "./health";
import { type SimConnection, createSimConnection } from "./host/connection";
import {
  type NarratorFailure,
  type NarratorOutcome,
  appendRecentEvents,
  callNarrator,
  hookAnswer,
} from "./host/narrator";
import { nextRetryAction, resetRetry, stagingRetryAction } from "./host/narratorRetry";
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
import type { DockTable } from "./render/dock";
import { DecisionModal, DecisionPill } from "./ui/DecisionModal";
import { Headline } from "./ui/Headline";
import { Inspector, type InspectorData } from "./ui/Inspector";
import { Log } from "./ui/Log";
import { NarratorErrorPanel } from "./ui/NarratorErrorPanel";
import { NarratorOverlay } from "./ui/NarratorOverlay";
import { Toast, useToast } from "./ui/Toast";
import { TopBar } from "./ui/TopBar";
import { TravelBar } from "./ui/TravelBar";
import { AFTERMATH_MS, aftermathCaption } from "./ui/aftermath";
import { dockInspection } from "./ui/dockInspection";
import { inspectItem } from "./ui/itemInspection";
import {
  type CardEntry,
  type LogEntry,
  answerDecision,
  appendDecision,
  appendTicker,
  visibleLog,
} from "./ui/log";
import { rejectionMessage } from "./ui/rejectionMessage";
import { loadWebContent } from "./worker/content";

/** Wall-clock cadence of routine server saves (PLAN §3: "Neon every ~60 s"). */
const REMOTE_SAVE_EVERY_MS = 60_000;
/** How long startup waits for the server before loading the local save on its own. */
const SERVER_OPEN_GRACE_MS = 3_000;

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

/** D43: the client is between attempts at a hook; shown on the overlay once the viewer is there. */
interface NarratorRetryStatus {
  readonly attempt: number;
  readonly nextRetryInMs: number;
  readonly lastReason: string;
}

/** D43: retries are exhausted (or pointless); the game is paused on the error panel. */
interface NarratorError {
  readonly hook: NarratorHook;
  readonly tick: Tick;
  readonly reason: string;
  readonly message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const docks: DockTable = useMemo(() => bundle.docks ?? {}, [bundle]);

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
  /** D55: everything received, stamped by tick; shown only as far as playback has reached. */
  const [log, setLog] = useState<LogEntry[]>([]);
  const [selection, setSelection] = useState<Selection>();
  const [inspectorData, setInspectorData] = useState<InspectorData>();
  const [pendingHook, setPendingHook] = useState<PendingHook>();
  const [narratorRetry, setNarratorRetry] = useState<NarratorRetryStatus>();
  const [narratorError, setNarratorError] = useState<NarratorError>();
  /** The effect's `answerHook`, for the error panel's Retry button. */
  const answerHookRef = useRef<((hook: NarratorHook, tick: Tick) => Promise<void>) | undefined>(
    undefined,
  );
  const [decision, setDecision] = useState<Decision>();
  const [decisionHidden, setDecisionHidden] = useState(false);
  const [prose, setProse] = useState<Readonly<Record<string, DecisionCardText>>>({});
  const health = useApiHealth();
  const [toast, showToast] = useToast();
  const [stale, setStale] = useState(false);
  /** D26: the card just answered, kept up with its aftermath caption until the timer closes it. */
  const [closingCard, setClosingCard] = useState<{
    readonly card: DecisionCardText;
    readonly side: "left" | "right";
    readonly caption: string;
  }>();
  const closingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closingTimer.current), []);

  /** Send `message` (built around a fresh request id); the worker's reply to it goes to `onReply`. */
  const request = useCallback(
    (
      connection: SimConnection,
      message: (requestId: string) => ToWorker,
      onReply: (reply: FromWorker) => void,
    ) => {
      const requestId = nextRequestId();
      pendingRequests.current.set(requestId, onReply);
      connection.send(message(requestId));
    },
    [],
  );

  const sendCommand = useCallback((connection: SimConnection, command: Command) => {
    const requestId = nextRequestId();
    if (command.source === "player") playerCommands.current.set(requestId, command.kind);
    connection.send({ type: "command", requestId, command });
  }, []);

  /** What the pause button does, also used when the narrator error panel pauses the game. */
  const applyPause = useCallback((next: boolean) => {
    setPausedState(next);
    pausedRef.current = next;
    connectionRef.current?.setUserPaused(next);
    connectionRef.current?.send({ type: next ? "pause" : "resume" });
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
        request(
          connection,
          (requestId) => ({ type: "requestSave", requestId }),
          (msg) => {
            if (msg.type === "saveBlob") resolve(msg.envelope);
            else reject(new Error(msg.type === "error" ? msg.message : `unexpected ${msg.type}`));
          },
        );
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

    const send = (command: Command): void => sendCommand(connection, command);

    /** One narrator call for a hook; every way it can fail is a `NarratorFailure` (D43). */
    async function attemptNarrator(hook: NarratorHook): Promise<NarratorOutcome> {
      const failed = (failure: NarratorFailure): NarratorOutcome => ({ ok: false, failure });
      let envelope: SaveEnvelope;
      try {
        envelope = await requestEnvelope();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failed({ kind: "retryable", reason: "snapshot", message });
      }
      if (serverRef.current === undefined) {
        return failed({
          kind: "retryable",
          reason: "network",
          message: "no server session for this game",
        });
      }
      return callNarrator({
        gameId: serverRef.current.gameId,
        token: serverRef.current.token,
        hook,
        snapshot: envelope,
        recentEvents: recentEventsRef.current.slice(),
      });
    }

    /**
     * D5/D43: call the narrator for a hook and apply its answer. On failure the hook stays
     * unacknowledged (the sim stays halted) while the client retries with backoff; when the
     * scheduler gives up, the game pauses on the error panel, whose Retry calls this again.
     * Only the spacing rule acknowledges a hook without an answer, and (D67) a staging call the
     * scheduler gave up on, which leaves the dock to the sim's floor set instead of pausing.
     */
    async function answerHook(hook: NarratorHook, tick: Tick): Promise<void> {
      const staging = hook.kind === "stageDock";
      setPendingHook({ hookId: hook.id, tick });
      setNarratorRetry(undefined);
      // Every entry (first hook, or the error panel's Retry) starts the sequence from attempt 1.
      let retry = resetRetry();
      for (;;) {
        const outcome = await attemptNarrator(hook);
        if (disposed) return;
        if (outcome.ok) {
          // D67: the staging call is not story; the next story call still needs these events.
          if (!staging) recentEventsRef.current.length = 0;
          // D37: a `policyDecision` hook halts before its decision does, so this prose is in
          // the map before `decisionPending` arrives and the modal opens dressed.
          const card = outcome.reply.card;
          if (card !== undefined) setProse((prev) => ({ ...prev, [card.decisionId]: card }));
          for (const command of hookAnswer(hook, tick, outcome.reply)) send(command);
          break;
        }
        const { failure } = outcome;
        const action = staging
          ? stagingRetryAction(retry, failure)
          : nextRetryAction(retry, failure);
        console.warn(`[narrator] ${failure.reason}: ${failure.message}`, action);
        if (action.type === "floorSet") {
          console.warn(`[narrator] staging fallback ${action.reason}`, action.message);
        }
        if (action.type === "acknowledge" || action.type === "floorSet") {
          for (const command of hookAnswer(hook, tick, undefined)) send(command);
          break;
        }
        if (action.type === "fail") {
          setNarratorRetry(undefined);
          setNarratorError({ hook, tick, reason: action.reason, message: action.message });
          applyPause(true);
          return;
        }
        retry = action.state;
        setNarratorRetry({
          attempt: action.attempt,
          nextRetryInMs: action.delayMs,
          lastReason: failure.reason,
        });
        await sleep(action.delayMs);
        if (disposed) return;
      }
      setNarratorRetry(undefined);
      setPendingHook(undefined);
    }
    answerHookRef.current = answerHook;

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
          const { tickerEvents } = message.frame;
          if (tickerEvents.length > 0) setLog((prev) => appendTicker(prev, tickerEvents));
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
          setLog((prev) => appendDecision(prev, message.decision));
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
      answerHookRef.current = undefined;
      clearInterval(remoteTimer);
      loop.stop();
      unsubscribe();
      connection.dispose();
    };
    // `scenarioId`/`saveEveryTicks` come from the content bundle loaded once, so they never change.
  }, [scenarioId, saveEveryTicks, showToast, applyPause, request, sendCommand]);

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
    applyPause(!pausedRef.current);
  }, [applyPause]);

  // -------------------------------------------------------------- narrator error (D43)
  /** Retry: resume the game and run the backoff sequence again from attempt 1. */
  const onRetryNarrator = useCallback(() => {
    const failed = narratorError;
    if (failed === undefined) return;
    setNarratorError(undefined);
    applyPause(false);
    void answerHookRef.current?.(failed.hook, failed.tick);
  }, [narratorError, applyPause]);

  // -------------------------------------------------------------- inspector
  const onSelect = useCallback(
    (next: Selection | undefined) => {
      setSelection(next);
      if (!next) {
        setInspectorData(undefined);
        return;
      }
      if (
        next.kind === "post" ||
        next.kind === "dock" ||
        next.kind === "local" ||
        next.kind === "dockProp"
      ) {
        // Content and the frame only (the dock map the canvas drew, its people and props), so no
        // snapshot is needed.
        setInspectorData(
          frame === undefined ? undefined : dockInspection(frame, docks, layout, next),
        );
        return;
      }
      setInspectorData({ kind: "loading" });
      const connection = connectionRef.current;
      if (!connection) return;
      const tick = frame?.tick ?? runAhead.viewTick;
      if (next.kind === "actor") {
        const label = frame?.actors.find((a) => a.id === next.id)?.actionLabel;
        const actorId = next.id as ActorId;
        request(
          connection,
          (requestId) => ({ type: "requestAgentView", requestId, actorId, tick }),
          (msg) => {
            if (msg.type === "agentViewResult") {
              setInspectorData({
                kind: "actor",
                view: msg.view as AgentViewSnapshot,
                ...(label === undefined ? {} : { label }),
              });
            } else if (msg.type === "error") {
              setInspectorData(undefined);
            }
          },
        );
        return;
      }
      request(
        connection,
        (requestId) => ({ type: "requestSnapshotAt", requestId, tick }),
        (msg) => {
          if (msg.type === "error") setInspectorData(undefined);
          if (msg.type !== "snapshot") return;
          if (next.kind === "item") {
            const item = inspectItem(msg.state, next.id as ItemId, bundle, layout);
            setInspectorData(item === undefined ? undefined : { kind: "item", item });
            return;
          }
          const machine = msg.state.machines[next.id as MachineId] as Machine | undefined;
          if (machine === undefined) {
            setInspectorData(undefined);
            return;
          }
          const name = bundle.machines[machine.defId]?.name;
          setInspectorData({ kind: "machine", machine, ...(name === undefined ? {} : { name }) });
        },
      );
    },
    [frame, runAhead.viewTick, bundle, layout, docks, request],
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
      sendCommand(connection, {
        id: nextCommandId(),
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: decision.id, side },
      });
      // D26: keep the answered card up for a moment with a line on what happens next. The sim
      // resumes behind it straight away; only the card lingers.
      const narrated = prose[decision.id];
      const caption = aftermathCaption(decision, side, narrated, bundle);
      setClosingCard({ card: narrated ?? templateCard(decision, bundle), side, caption });
      setLog((prev) => answerDecision(prev, decision.id, { side, caption }));
      clearTimeout(closingTimer.current);
      closingTimer.current = setTimeout(() => setClosingCard(undefined), AFTERMATH_MS);
      setDecision(undefined);
      setDecisionHidden(false);
    },
    [decision, prose, bundle, sendCommand],
  );

  const onNewGame = useCallback(() => {
    forgetServerGame();
    void clearLocalSave().then(() => window.location.reload());
  }, []);

  const viewTick = frame?.tick ?? 0;
  // D14: the worker may be ahead of the viewer; show hook/decision UI once playback reaches it.
  const thinking = pendingHook !== undefined && viewTick >= pendingHook.tick;
  // D70: a card held for delivery in person is due when it was delivered, not when it was made.
  const decisionDue = decision !== undefined && viewTick >= decisionShownTick(decision);
  const card = useMemo(() => {
    if (decision === undefined) return undefined;
    return prose[decision.id] ?? templateCard(decision, bundle);
  }, [decision, prose, bundle]);

  const money = frame?.money ?? 0;
  const travelState = frame?.travel.state ?? "docked";
  const showCard = card !== undefined && decisionDue && !decisionHidden && !thinking;
  const runAheadSeconds = runAhead.buffered / tickRate;

  // D55: the log follows playback, not the worker.
  const visible = useMemo(() => visibleLog(log, viewTick), [log, viewTick]);
  const logCardText = useCallback(
    (entry: CardEntry) => prose[entry.decision.id] ?? templateCard(entry.decision, bundle),
    [prose, bundle],
  );

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
        <DeckCanvas
          layout={layout}
          ports={bundle.ports}
          docks={docks}
          frame={frame}
          paused={paused}
          selected={selection}
          onSelect={onSelect}
        />
        <Log
          entries={visible}
          cardText={logCardText}
          onOpenDecision={() => setDecisionHidden(false)}
        />
      </div>
      <Inspector data={inspectorData} onClose={onCloseInspector} />
      {narratorError !== undefined ? (
        <NarratorErrorPanel
          reason={narratorError.reason}
          message={narratorError.message}
          onRetry={onRetryNarrator}
        />
      ) : (
        thinking && (
          <NarratorOverlay
            {...(narratorRetry === undefined ? {} : { attempt: narratorRetry.attempt })}
          />
        )
      )}
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
