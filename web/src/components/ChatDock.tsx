import { useEffect, useRef, useState } from "react";
import { api, type ChatAction, type ChatMessage } from "../lib/api";
import { Spark } from "./ShelfSuggestions";

type ActionState = "open" | "busy" | "done" | "skipped" | "failed";
interface Turn extends ChatMessage {
  actions?: (ChatAction & { state: ActionState; error?: string })[];
}

const STORE = "chat:v1";
const load = (): Turn[] => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? "[]") as Turn[];
  } catch {
    return [];
  }
};

interface Props {
  /** Something in the library changed (a confirmed action). */
  onChanged: () => void;
  onOpenBook: (id: string) => void;
}

/**
 * A quiet text box docked at the bottom of the page for talking to the AI librarian.
 * It stays dim until you tap it; the conversation unfolds above it. Changes the librarian
 * suggests show as small cards and only happen when you confirm them.
 */
export function ChatDock({ onChanged, onOpenBook }: Props) {
  const [turns, setTurns] = useState<Turn[]>(load);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(turns.slice(-30)));
    } catch {
      /* private mode: the chat just isn't kept */
    }
  }, [turns]);

  // Keep the newest message in view.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns, busy, open]);

  // Tap outside or press Escape to tuck it away again.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      inputRef.current?.blur();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  // The box grows with what you type, up to a few lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const send = async () => {
    const content = text.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: "user", content }];
    setTurns(next);
    setText("");
    setOpen(true);
    setBusy(true);
    try {
      const res = await api.chat(next.map(({ role, content }) => ({ role, content })));
      setTurns((t) => [...t, { role: "assistant", content: res.reply, actions: res.actions.map((a) => ({ ...a, state: "open" as const })) }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", content: `Sorry, I couldn’t answer that: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const setAction = (ti: number, ai: number, patch: { state?: ActionState; error?: string }) =>
    setTurns((t) => t.map((turn, i) => (i !== ti ? turn : { ...turn, actions: turn.actions?.map((a, j) => (j === ai ? { ...a, ...patch } : a)) })));

  const confirm = async (ti: number, ai: number) => {
    const a = turns[ti]?.actions?.[ai];
    if (!a) return;
    setAction(ti, ai, { state: "busy" });
    try {
      const { state: _s, error: _e, ...action } = a;
      const res = await api.applyChatAction(action);
      setAction(ti, ai, { state: "done" });
      if (res.openBookId) return onOpenBook(res.openBookId);
      onChanged();
      if (res.shelfId) setTimeout(() => document.getElementById(`shelf-${res.shelfId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
    } catch (e) {
      setAction(ti, ai, { state: "failed", error: (e as Error).message });
    }
  };

  const showLog = open && (turns.length > 0 || busy);

  return (
    <div className={`chat${open ? " is-open" : ""}`} ref={rootRef}>
      {showLog && (
        <div className="chat__panel">
          <div className="chat__bar">
            <span className="chat__kicker">
              <Spark /> Librarian
            </span>
            <span className="chat__tools">
              <button type="button" className="chat__link" onClick={() => setTurns([])} disabled={busy}>
                New chat
              </button>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Hide chat">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <path d="m2 4 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </span>
          </div>
          <div className="chat__log" ref={logRef} aria-live="polite">
            {turns.map((t, ti) => (
              <div key={ti} className={`chat__msg chat__msg--${t.role}`}>
                <p>{t.content}</p>
                {t.actions?.map((a, ai) => (
                  <div key={ai} className={`chat__action is-${a.state}`}>
                    <span className="chat__summary">{a.summary}</span>
                    {a.state === "open" && (
                      <span className="chat__buttons">
                        <button type="button" className="btn btn--primary" onClick={() => void confirm(ti, ai)}>
                          {a.type === "open_book" ? "Open" : "Do it"}
                        </button>
                        <button type="button" className="btn" onClick={() => setAction(ti, ai, { state: "skipped" })}>
                          Skip
                        </button>
                      </span>
                    )}
                    {a.state === "busy" && <span className="chat__status">Working…</span>}
                    {a.state === "done" && <span className="chat__status">Done</span>}
                    {a.state === "skipped" && <span className="chat__status">Skipped</span>}
                    {a.state === "failed" && <span className="chat__status chat__status--error">{a.error}</span>}
                  </div>
                ))}
              </div>
            ))}
            {busy && (
              <div className="chat__msg chat__msg--assistant">
                <span className="chat__typing" aria-label="Thinking">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      <form
        className="chat__box"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span className="chat__spark" aria-hidden>
          <Spark />
        </span>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder="Ask the librarian about your books…"
          aria-label="Ask the librarian"
          onFocus={() => setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="chat__send" disabled={!text.trim() || busy} aria-label="Send">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M7 12V2m-4.5 4.5L7 2l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}
