import type { AgentViewSnapshot, Machine } from "@crew/sim";
import { type PersonWords, actorSubtitle, rosterRole, thoughtText } from "./actorWords";
import type { LocalInspection } from "./localInspection";
import type { PlaceInspection } from "./placeInspection";

export type InspectorData =
  | {
      readonly kind: "actor";
      readonly view: AgentViewSnapshot;
      readonly label?: string;
      /** D77/D79: their watch, mood and thoughts in words (`personWords`). */
      readonly person: PersonWords;
    }
  | { readonly kind: "machine"; readonly machine: Machine; readonly name?: string }
  | { readonly kind: "item"; readonly item: ItemInspection }
  /** Dockside phase 2: a dock post, or the dock itself; phase 3 (D68): a staged prop. */
  | { readonly kind: "place"; readonly place: PlaceInspection }
  /** Dockside phase 3 (D68): one of the dock's own people. */
  | { readonly kind: "local"; readonly local: LocalInspection }
  | { readonly kind: "loading" };

/** Polish A: what the inspector shows for a tapped crate (or any item on deck). */
export interface ItemInspection {
  readonly name: string;
  readonly count: number;
  /** Plain words: "in the cargo hold", "carried by Mara Osei". */
  readonly where: string;
  /** Present when the item is freight on a contract. */
  readonly job?: {
    readonly issuer: string;
    readonly from: string;
    readonly to: string;
    readonly status: string;
  };
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
          <ActorInspector view={data.view} label={data.label} person={data.person} />
        )}
        {data.kind === "machine" && <MachineInspector machine={data.machine} name={data.name} />}
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
}: {
  view: AgentViewSnapshot;
  label?: string | undefined;
  person: PersonWords;
}) {
  const self = view.self;
  // Passengers stand no watch (passengers §3.2): the bill and the helm are the crew's.
  const crew = self.passenger !== true;
  return (
    <div>
      <h2>{self.name}</h2>
      <p className="inspector-subtitle">{actorSubtitle(self)}</p>
      <dl className="inspector-grid">
        <dt>Activity</dt>
        <dd>{label ?? self.activity.kind}</dd>
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
                <li key={t.key} className={t.value < 0 ? "thought-down" : "thought-up"}>
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
      </dl>
      <h3>Known problems</h3>
      {view.problems.length === 0 && <p className="inspector-empty">None known.</p>}
      <ul>
        {view.problems.map((p) => (
          <li key={p.id}>{p.kind}</li>
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

function MachineInspector({ machine, name }: { machine: Machine; name?: string | undefined }) {
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

/** D63: freight on offer is staged on the dock but belongs to nobody until the job is taken. */
function itemSubtitle(item: ItemInspection): string {
  if (item.job === undefined) return "ship's stores";
  return item.job.status === "offered" ? "freight on offer" : "freight";
}

function ItemInspector({ item }: { item: ItemInspection }) {
  return (
    <div>
      <h2>{item.name}</h2>
      <p className="inspector-subtitle">{itemSubtitle(item)}</p>
      {item.job?.status === "offered" && (
        <p>Set out for whoever takes the job; nobody loads it until then.</p>
      )}
      <dl className="inspector-grid">
        <dt>Count</dt>
        <dd>{item.count}</dd>
        <dt>Where</dt>
        <dd>{item.where}</dd>
        {item.job !== undefined && (
          <>
            <dt>Going to</dt>
            <dd>{item.job.to}</dd>
            <dt>From</dt>
            <dd>{item.job.from}</dd>
            <dt>For</dt>
            <dd>{item.job.issuer}</dd>
            <dt>Contract</dt>
            <dd>{JOB_STATUS_WORDS[item.job.status] ?? item.job.status}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
