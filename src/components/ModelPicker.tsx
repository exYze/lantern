import { useApp } from "../lib/store";
import type { ModelRef } from "../lib/types";

const SEP = "::";

export function ModelPicker({
  value,
  onChange,
  defaultLabel,
  className = "",
}: {
  value?: ModelRef;
  onChange: (v: ModelRef | undefined) => void;
  /** When set, an empty option with this label means "inherit the default". */
  defaultLabel?: string;
  className?: string;
}) {
  const providers = useApp((s) => s.providers);
  const current = value ? `${value.providerId}${SEP}${value.model}` : "";
  const known = providers.some((p) => p.id === value?.providerId && p.models.includes(value.model));
  return (
    <select
      className={`select ${className}`}
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return onChange(undefined);
        const i = v.indexOf(SEP);
        onChange({ providerId: v.slice(0, i), model: v.slice(i + SEP.length) });
      }}
    >
      {defaultLabel !== undefined ? <option value="">{defaultLabel}</option> : !value && <option value="">Choose a model…</option>}
      {value && !known && (
        <option value={current}>
          {value.model} (unavailable)
        </option>
      )}
      {providers.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {p.models.length ? (
            p.models.map((m) => (
              <option key={m} value={`${p.id}${SEP}${m}`}>
                {m}
              </option>
            ))
          ) : (
            <option disabled value={`${p.id}${SEP}`}>
              No models found
            </option>
          )}
        </optgroup>
      ))}
    </select>
  );
}
