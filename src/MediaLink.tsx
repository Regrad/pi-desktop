import { useState, type ReactNode } from "react";
import { defaultUrlTransform } from "react-markdown";
import { generatedLinkLabel, parseGeneratedLink } from "../shared/generated-links";

export function markdownMediaUrl(value: string, key: string): string {
  return key === "href" && parseGeneratedLink(value) ? value : defaultUrlTransform(value);
}

export function MediaLink({ href, children }: { href?: string; children?: ReactNode }) {
  const [error, setError] = useState("");
  const generated = href ? parseGeneratedLink(href) : undefined;
  if (!generated || !href) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  const text = typeof children === "string" ? children : Array.isArray(children) && children.every(item => typeof item === "string") ? children.join("") : undefined;
  const open = async () => {
    setError("");
    try {
      if (window.piDesktop.webClient) await window.piDesktop.showGeneratedFile(generated.kind, generated.filename);
      else await window.piDesktop.openGeneratedLink(href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <><a href={href} title={generated.filename} style={{ overflowWrap: "anywhere" }} onClick={event => { event.preventDefault(); void open(); }}>{text === undefined ? children : generatedLinkLabel(href, text)}</a>{error && <span role="alert"> — {error}</span>}</>;
}
