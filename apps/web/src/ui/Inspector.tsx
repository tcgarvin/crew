import type { AgentViewSnapshot, Machine, UrgencyClass, WeighingWords } from "@crew/sim";
import {
  type PersonWords,
  actorSubtitle,
  problemLines,
  rosterRole,
  thoughtText,
} from "./actorWords";
import { bodyLine } from "./bodyWords";
import type { LocalInspection } from "./localInspection";
import type { PlaceInspection } from "./placeInspection";

export type InspectorData =
  | {
      readonly kind: "actor";
      readonly view: AgentViewSnapshot;
      readonly label?: string;
      /** §mood-and-work-speed: their watch, mood and thoughts in words (`personWords`). */
      readonly person: PersonWords;
      /** §what-a-crew-member-weighs: what they are weighing and what they will do next. */
      readonly weighing: WeighingWords;
    }
  | {
      readonly kind: "machine";
      readonly machine: Machine;
      readonly name?: string;
      /** Slice 4: the session held at this machine (`gatheringLine`), when there is one. */
      readonly gathering?: string;
    }
  | { readonly kind: "item"; readonly item: ItemInspection }
  /**
   * Dockside phase 2: a dock post, or the dock itself; phase 3 (§items-places-and-locals): a staged
   * prop.
   */
  | { readonly kind: "place"; readonly place: PlaceInspection }
  /** Dockside phase 3 (§items-places-and-locals): one of the dock's own people. */
  | { readonly kind: "local"; readonly local: LocalInspection }
  | { readonly kind: "loading" };

/** Polish A: what the inspector shows for a tapped crate (or any item on deck). */
export interface ItemInspection {
  readonly name: string;
  readonly count: number;
  /** Plain words: "in the cargo hold", "carried by Mara Osei". */
  readonly where: string;
  /** Present when the item is freight on a contract, or what an errand fetches. */
  readonly job?: {
    readonly issuer: string;
    readonly from: string;
    readonly to: string;
    readonly status: string;
    /** Expeditions A2: the job is an errand to a site, not freight (`errandWords`). */
    readonly errand?: ErrandWords;
  };
}

/** Expeditions A2 (§6): an errand in words, with no numbers (§cards-never-mention-pay). */
export interface ErrandWords {
  /** "Bring back Teodor Lusk from Harrow End, alive", "Fetch the strongbox papers from Harrow End". */
  readonly what: string;
  /** The port the errand comes home to and pays at. */
  readonly home: string;
}

export interface InspectorProps {
  readonly data: InspectorData | undefined;
  readonly onClose: () => void;
}

/** Side sheet on desktop, bottom sheet on phone (CSS handles the layout switch). */
export function Inspector({ data, onClose }: InspectorProps) {
  if (!data) return null;
  return (
    <div
      className="inspector-backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <aside
        className="inspector-sheet"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label="Inspector"
      >
        <div className="inspector-handle" />
        <button type="button" className="inspector-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        {data.kind === "loading" && <p>Loading…</p>}
        {data.kind === "actor" && (
          <ActorInspector
            view={data.view}
            label={data.label}
            person={data.person}
            weighing={data.weighing}
          />
        )}
        {data.kind === "machine" && (
          <MachineInspector machine={data.machine} name={data.name} gathering={data.gathering} />
        )}
        {data.kind === "item" && <ItemInspector item={data.item} />}
        {data.kind === "place" && <PlaceInspector place={data.place} />}
        {data.kind === "local" && <LocalInspector local={data.local} />}
      </aside>
    </div>
  );
}

function ActorInspector({
  view,
  label,
  person,
  weighing,
}: {
  view: AgentViewSnapshot;
  label?: string | undefined;
  person: PersonWords;
  weighing: WeighingWords;
}) {
  const self = view.self;
  const body = bodyLine(self.body);
  // Expeditions A1 (§5.1): a site's cast member has no watch, needs or work of ours to show.
  if (self.combatant?.side === "them") return <CastInspector view={view} body={body} />;
  // Passengers stand no watch (passengers §3.2): the bill and the helm are the crew's.
  const crew = self.passenger !== true;
  return (
    <div>
      <h2>{self.name}</h2>
      <p className="inspector-subtitle">{actorSubtitle(self)}</p>
      <dl className="inspector-grid">
        <dt>Activity</dt>
        <dd>{label ?? self.activity.kind}</dd>
        <BodyRow body={body} />
        {crew && (
          <>
            <dt>Watch</dt>
            <dd>{person.watch}</dd>
          </>
        )}
        {crew && person.helm !== undefined && (
          <>
            <dt>Duty</dt>
            <dd>{person.helm}</dd>
          </>
        )}
        <dt>Mood</dt>
        <dd className={`inspector-mood inspector-mood-${person.mood}`}>{person.mood}</dd>
        <dt>Thoughts</dt>
        <dd>
          {person.thoughts.length === 0 ? (
            <span className="inspector-empty">nothing in particular</span>
          ) : (
            <ul className="inspector-thoughts">
              {person.thoughts.map((t) => (
                <li key={t.label} className={t.value < 0 ? "thought-down" : "thought-up"}>
                  {thoughtText(t)}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Hunger</dt>
        <dd>{Math.round(self.needs.hunger * 100)}%</dd>
        <dt>Fatigue</dt>
        <dd>{Math.round(self.needs.fatigue * 100)}%</dd>
        <dt>Comfort</dt>
        <dd>{Math.round(self.needs.comfort * 100)}%</dd>
        <dt>Social</dt>
        <dd>{Math.round(self.needs.social * 100)}%</dd>
        <dt>Recreation</dt>
        <dd>{Math.round(self.needs.recreation * 100)}%</dd>
        <dt>Off watch</dt>
        <dd>{person.interests}</dd>
        {person.relationships.length > 0 && (
          <>
            <dt>People</dt>
            <dd>
              <ul className="inspector-people">
                {person.relationships.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {crew && <WeighingSection weighing={weighing} />}
      <h3>Known problems</h3>
      {view.problems.length === 0 && <p className="inspector-empty">None known.</p>}
      <ul>
        {problemLines(view.problems).map((line) => (
          <li key={line.kind}>{line.text}</li>
        ))}
      </ul>
      <h3>Roster</h3>
      <ul>
        {view.roster.map((r) => (
          <li key={r.actorId}>
            {r.name} —{" "}
            {r.passenger === true ? (
              <span className="inspector-tag">{rosterRole(r)}</span>
            ) : (
              rosterRole(r)
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Expeditions A1 (§8.6): the body line, marked when they are hurt. */
function BodyRow({ body }: { body: string }) {
  return (
    <>
      <dt>Body</dt>
      <dd className={body === "unhurt" ? undefined : "inspector-hurt"}>{body}</dd>
    </>
  );
}

/**
 * Expeditions A1 (§5.1, §8.6): one of a site's cast: who they are, their role there, their body and
 * where they stand in the fight. They stand no watch and plan no work of ours, so the crew's
 * sections are left out.
 */
function CastInspector({ view, body }: { view: AgentViewSnapshot; body: string }) {
  const self = view.self;
  return (
    <div>
      <h2>{self.name}</h2>
      <p className="inspector-subtitle">{self.bio}</p>
      <dl className="inspector-grid">
        <BodyRow body={body} />
        {self.combatant !== undefined && (
          <>
            <dt>State</dt>
            <dd>{self.combatant.state}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** §what-a-crew-member-weighs: urgency classes in the inspector's words, most pressing first. */
const URGENCY_WORDS: Readonly<Record<UrgencyClass, string>> = {
  immediateSurvival: "emergency",
  containment: "urgent",
  essentialOperation: "essential",
  routineObligation: "routine",
  voluntaryActivity: "if nothing else",
};

/**
 * §what-a-crew-member-weighs: the options the planner is weighing, best first. It takes the most
 * pressing class, then the quickest within it; a current activity is kept against anything of the
 * same class or lower.
 */
function WeighingSection({ weighing }: { weighing: WeighingWords }) {
  return (
    <>
      <h3>Weighing</h3>
      <p className="weighing-verdict">{weighing.verdict}</p>
      {weighing.options.length === 0 ? (
        <p className="inspector-empty">Nothing else in view.</p>
      ) : (
        <ol className="inspector-weighing">
          {weighing.options.map((option, i) => (
            <li key={`${i}:${option.text}`} className={option.mark ? "weighing-marked" : undefined}>
              {option.text}{" "}
              <span className={`inspector-tag urgency-${option.urgency}`}>
                {URGENCY_WORDS[option.urgency]}
              </span>{" "}
              <span className="weighing-seconds">~{option.seconds}s</span>
              {option.mark === "doing" && <span className="weighing-mark"> · doing</span>}
              {option.mark === "next" && <span className="weighing-mark"> · next</span>}
            </li>
          ))}
        </ol>
      )}
      {weighing.ruledOut.length > 0 && (
        <details className="inspector-ruled-out">
          <summary>Ruled out ({weighing.ruledOut.length})</summary>
          <ul>
            {weighing.ruledOut.map((r, i) => (
              <li key={`${i}:${r.text}`}>
                {r.text}: <span className="inspector-empty">{r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function MachineInspector({
  machine,
  name,
  gathering,
}: {
  machine: Machine;
  name?: string | undefined;
  gathering?: string | undefined;
}) {
  return (
    <div>
      <h2>{name ?? machine.defId}</h2>
      <dl className="inspector-grid">
        <dt>Mode</dt>
        <dd>{machine.actualMode}</dd>
        <dt>Integrity</dt>
        <dd>{Math.round(machine.integrity * 100)}%</dd>
        <dt>Condition</dt>
        <dd>{Math.round(machine.condition * 100)}%</dd>
        <dt>Temperature</dt>
        <dd>{Math.round(machine.temperature * 100)}%</dd>
        <dt>Faults</dt>
        <dd>
          {machine.faults.length === 0 ? "none" : machine.faults.map((f) => f.faultKey).join(", ")}
        </dd>
        {gathering !== undefined && (
          <>
            <dt>Gathering</dt>
            <dd>{gathering}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

const JOB_STATUS_WORDS: Readonly<Record<string, string>> = {
  offered: "on offer",
  accepted: "waiting to ship",
  inTransit: "in transit",
  delivered: "delivered",
  paid: "delivered and paid",
  failed: "failed",
};

function PlaceInspector({ place }: { place: PlaceInspection }) {
  return (
    <div>
      <h2>{place.title}</h2>
      <p className="inspector-subtitle">{place.subtitle}</p>
      <p>{place.text}</p>
    </div>
  );
}

function LocalInspector({ local }: { local: LocalInspection }) {
  return (
    <div>
      <h2>{local.name}</h2>
      <p className="inspector-subtitle">{local.role}</p>
      {local.look !== undefined && <p>{local.look}</p>}
      <dl className="inspector-grid">
        <dt>Where</dt>
        <dd>{local.where}</dd>
        {local.post !== undefined && (
          <>
            <dt>Post</dt>
            <dd>{local.post}</dd>
          </>
        )}
        {local.doing !== undefined && (
          <>
            <dt>Doing</dt>
            <dd>{local.doing}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * §offered-freight: freight on offer is staged on the dock but belongs to nobody until the job is
 * taken.
 */
function itemSubtitle(item: ItemInspection): string {
  if (item.job === undefined) return "ship's stores";
  if (item.job.errand !== undefined) return "an errand";
  return item.job.status === "offered" ? "freight on offer" : "freight";
}

/** Expeditions A2: an errand's contract in its own words; it is never waiting to ship. */
const ERRAND_STATUS_WORDS: Readonly<Record<string, string>> = {
  offered: "on offer",
  accepted: "taken",
  inTransit: "under way",
  delivered: "brought back",
  paid: "brought back and paid",
  failed: "failed",
};

type ItemJob = NonNullable<ItemInspection["job"]>;

function FreightRows({ job }: { job: ItemJob }) {
  return (
    <>
      <dt>Going to</dt>
      <dd>{job.to}</dd>
      <dt>From</dt>
      <dd>{job.from}</dd>
      <dt>For</dt>
      <dd>{job.issuer}</dd>
      <dt>Contract</dt>
      <dd>{JOB_STATUS_WORDS[job.status] ?? job.status}</dd>
    </>
  );
}

function ErrandRows({ job, errand }: { job: ItemJob; errand: ErrandWords }) {
  return (
    <>
      <dt>Errand</dt>
      <dd>{errand.what}</dd>
      <dt>Back to</dt>
      <dd>{errand.home}</dd>
      <dt>For</dt>
      <dd>{job.issuer}</dd>
      <dt>Contract</dt>
      <dd>{ERRAND_STATUS_WORDS[job.status] ?? job.status}</dd>
    </>
  );
}

function ItemInspector({ item }: { item: ItemInspection }) {
  const job = item.job;
  return (
    <div>
      <h2>{item.name}</h2>
      <p className="inspector-subtitle">{itemSubtitle(item)}</p>
      {job?.status === "offered" && job.errand === undefined && (
        <p>Set out for whoever takes the job; nobody loads it until then.</p>
      )}
      <dl className="inspector-grid">
        <dt>Count</dt>
        <dd>{item.count}</dd>
        <dt>Where</dt>
        <dd>{item.where}</dd>
        {job !== undefined &&
          (job.errand === undefined ? (
            <FreightRows job={job} />
          ) : (
            <ErrandRows job={job} errand={job.errand} />
          ))}
      </dl>
    </div>
  );
}
