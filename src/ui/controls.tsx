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

export const MEDIA_TYPE_ICON: Record<string, IconName> = {
  Movie: "film",
  TV: "tv",
  Book: "book-open",
  Game: "gamepad-2",
  Podcast: "mic",
  "One-Off": "bookmark",
};

export const STATUS_META: Record<string, { icon: IconName; tone: "neutral" | "mid" | "good" | "warn" | "bad" }> = {
  Backlog: { icon: "clock", tone: "neutral" },
  "Up Next": { icon: "list-ordered", tone: "mid" },
  Active: { icon: "play", tone: "mid" },
  Paused: { icon: "pause", tone: "warn" },
  Completed: { icon: "check", tone: "good" },
  Abandoned: { icon: "x", tone: "bad" },
  Archived: { icon: "archive", tone: "neutral" },
};

export function StarRating(props: {
  id?: string;
  itemId?: string;
  name?: string;
  value: number | null;
  label: string;
  mode: "inline" | "form";
}) {
  return (
    <div
      class="app-stars"
      role="group"
      aria-label={props.label}
      data-stars-mode={props.mode}
      data-rating-value={props.value !== null ? String(props.value) : ""}
    >
      <input
        type="hidden"
        id={props.id}
        name={props.name}
        value={props.value !== null ? String(props.value) : ""}
        {...(props.mode === "inline" && props.itemId ? { "data-action": "rating", "data-id": props.itemId } : {})}
      />
      {[1, 2, 3, 4, 5].map((n) => {
        const state = props.value !== null && props.value >= n ? "full" : props.value !== null && props.value >= n - 0.5 ? "half" : "empty";
        const cls = state === "empty" ? "ui-icon-btn app-star" : `ui-icon-btn app-star app-star--${state}`;
        const icon: IconName = state === "half" ? "star-half" : "star";
        const titleText = props.value !== null ? `${props.value.toFixed(1)} / 5 — click to rate ${n}` : `Rate ${n} ${n === 1 ? "star" : "stars"}`;
        return (
          <button
            type="button"
            class={cls}
            data-action="star-rate"
            data-star={String(n)}
            {...(props.itemId ? { "data-id": props.itemId } : {})}
            aria-label={`Rate ${n} ${n === 1 ? "star" : "stars"}`}
            aria-pressed={state !== "empty" ? "true" : "false"}
            title={titleText}
          >
            <Icon name={icon} size={16} />
          </button>
        );
      })}
    </div>
  );
}
