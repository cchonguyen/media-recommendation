import type { Child } from "hono/jsx";
import { Icon, type IconName } from "./icons";

export function SelectBox(props: {
  id?: string;
  name?: string;
  label?: string;
  required?: boolean;
  attrs?: Record<string, string>;
  children?: Child;
}) {
  return (
    <div class="ui-select-wrap">
      <select
        class="ui-select"
        id={props.id}
        name={props.name}
        aria-label={props.label}
        required={props.required}
        {...(props.attrs ?? {})}
      >
        {props.children}
      </select>
      <Icon name="chevron-down" />
    </div>
  );
}

export function Field(props: { id: string; label: string; help?: string; children?: Child }) {
  return (
    <div class="ui-field">
      <label class="ui-eyebrow" for={props.id}>
        {props.label}
      </label>
      {props.children}
      {props.help ? (
        <span class="ui-help" id={`${props.id}-help`}>
          {props.help}
        </span>
      ) : null}
    </div>
  );
}

// Rule: a Pill with tone good, warn or bad must pass icon (state is never colour alone).
export function Pill(props: {
  tone?: "mid" | "active" | "good" | "warn" | "bad";
  icon?: IconName;
  children?: Child;
}) {
  return (
    <span class={props.tone ? `ui-pill ui-pill--${props.tone}` : "ui-pill"}>
      {props.icon ? <Icon name={props.icon} /> : null}
      {props.children}
    </span>
  );
}

export function Missing(props: { text?: string }) {
  return <span class="ui-missing">{props.text ?? "Not known yet"}</span>;
}
