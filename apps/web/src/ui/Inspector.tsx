import type { AgentViewSnapshot, Machine } from "@crew/sim";
import { actorSubtitle, rosterRole } from "./actorWords";

export type InspectorData =
  | { readonly kind: "actor"; readonly view: AgentViewSnapshot; readonly label?: string }
  | { readonly kind: "machine"; readonly machine: Machine; readonly name?: string }
  | { readonly kind: "item"; readonly item: ItemInspection }
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
        {data.kind === "actor" && <ActorInspector view={data.view} label={data.label} />}
        {data.kind === "machine" && <MachineInspector machine={data.machine} name={data.name} />}
        {data.kind === "item" && <ItemInspector item={data.item} />}
      </aside>
    </div>
  );
}

function ActorInspector({ view, label }: { view: AgentViewSnapshot; label?: string | undefined }) {
  const self = view.self;
  return (
    <div>
      <h2>{self.name}</h2>
      <p className="inspector-subtitle">{actorSubtitle(self)}</p>
      <dl className="inspector-grid">
        <dt>Activity</dt>
        <dd>{label ?? self.activity.kind}</dd>
        <dt>Hunger</dt>
        <dd>{Math.round(self.needs.hunger * 100)}%</dd>
        <dt>Fatigue</dt>
        <dd>{Math.round(self.needs.fatigue * 100)}%</dd>
        <dt>Comfort</dt>
        <dd>{Math.round(self.needs.comfort * 100)}%</dd>
        <dt>Social</dt>
        <dd>{Math.round(self.needs.social * 100)}%</dd>
        <dt>Mood</dt>
        <dd>{self.mood.toFixed(2)}</dd>
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

function ItemInspector({ item }: { item: ItemInspection }) {
  return (
    <div>
      <h2>{item.name}</h2>
      <p className="inspector-subtitle">{item.job === undefined ? "ship's stores" : "freight"}</p>
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
