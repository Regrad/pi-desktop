import { useState } from "react";
import type { ChatHistoryMark } from "../shared/chat-history";
import { getLocale, t } from "./i18n";

export function ChatTimeline({ marks, position, atEnd, onSelect, onEnd }: {
  marks: ChatHistoryMark[];
  position: number;
  atEnd: boolean;
  onSelect: (mark: ChatHistoryMark) => void;
  onEnd: () => void;
}) {
  const [hover, setHover] = useState(-10);
  const active = atEnd ? marks.length : marks.reduce((selected, mark, index) => mark.position <= position ? index : selected, 0);
  return <nav className="chat-timeline" aria-label={t("Навигация по чату")}
    onPointerLeave={() => setHover(-10)} onKeyDown={event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll("button")];
      const current = buttons.indexOf(event.target as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
        Math.max(0, Math.min(buttons.length - 1, current + (event.key === "ArrowUp" ? -1 : 1)));
      buttons[next]?.focus();
    }}>
    {[...marks, undefined].map((mark, index) => {
      const distance = Math.abs(hover - index);
      const date = mark && Number.isFinite(mark.timestamp) ? new Date(mark.timestamp).toLocaleString(getLocale(), { dateStyle: "short", timeStyle: "short" }) : "";
      const label = mark ? t("К сообщению от {0}", date) : t("В конец чата");
      return <button key={mark?.id ?? "end"} type="button" title={label} aria-label={label}
        aria-current={active === index ? "location" : undefined}
        tabIndex={active === index ? 0 : -1}
        data-near={distance < 3 ? distance : undefined}
        onPointerEnter={() => setHover(index)} onClick={() => mark ? onSelect(mark) : onEnd()}>
        <span aria-hidden="true" />
      </button>;
    })}
  </nav>;
}
