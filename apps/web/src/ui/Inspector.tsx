import type { AgentViewSnapshot, Machine } from "@crew/sim";

export type InspectorData =
  | { readonly kind: "actor"; readonly view: AgentViewSnapshot; readonly label?: string }
  | { readonly kind: "machine"; readonly machine: Machine; readonly name?: string }
  | { readonly kind: "loading" };

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
      </aside>
    </div>
  );
}

function ActorInspector({ view, label }: { view: AgentViewSnapshot; label?: string | undefined }) {
  const self = view.self;
  return (
    <div>
      <h2>{self.name}</h2>
      <p className="inspector-subtitle">{self.roleTags.join(", ") || "crew"}</p>
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
            {r.name} — {r.roleTags.join(", ")}
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
