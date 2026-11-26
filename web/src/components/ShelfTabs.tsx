import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface Props {
  shelves: { id: string; name: string; count: number }[];
  onCreate: (name: string) => void;
}

/**
 * A pill of shelf names that follows you down the page. A sliding indicator marks
 * the shelf in view; clicking a name glides to that shelf.
 */
export function ShelfTabs({ shelves, onCreate }: Props) {
  const [active, setActive] = useState<string | undefined>(shelves[0]?.id);
  const [adding, setAdding] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);
  const lock = useRef(0);

  useEffect(() => {
    const els = shelves.map((s) => document.getElementById(`shelf-${s.id}`)).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (performance.now() < lock.current) return;
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive((vis[0].target as HTMLElement).dataset.shelf);
      },
      { rootMargin: "-35% 0px -50% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [shelves]);

  // Slide the indicator under the active tab and keep that tab scrolled into view.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const ind = indRef.current;
    const tab = bar?.querySelector<HTMLElement>(`[data-id="${CSS.escape(active ?? "")}"]`);
    if (!bar || !ind) return;
    if (!tab) return void (ind.style.opacity = "0");
    ind.style.opacity = "1";
    ind.style.width = `${tab.offsetWidth}px`;
    ind.style.transform = `translateX(${tab.offsetLeft}px)`;
    const l = tab.offsetLeft - bar.clientWidth / 2 + tab.offsetWidth / 2;
    bar.scrollTo({ left: l, behavior: "smooth" });
  }, [active, shelves]);

  return (
    <nav className="tabs-wrap" aria-label="Shelves">
      <div className="tabs" ref={barRef}>
        <span className="tabs__ind" ref={indRef} aria-hidden />
        {shelves.map((s) => (
          <a
            key={s.id}
            data-id={s.id}
            href={`#shelf-${s.id}`}
            className={`tabs__tab${active === s.id ? " is-on" : ""}`}
            aria-current={active === s.id ? "true" : undefined}
            onClick={(e) => {
              e.preventDefault();
              lock.current = performance.now() + 900;
              setActive(s.id);
              document.getElementById(`shelf-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            {s.name}
            <span className="tabs__count">{s.count}</span>
          </a>
        ))}
        {adding ? (
          <form
            className="tabs__new"
            onSubmit={(e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get("name")?.toString().trim();
              if (name) onCreate(name);
              setAdding(false);
            }}
          >
            <input name="name" autoFocus placeholder="Shelf name" onBlur={() => setAdding(false)} aria-label="New shelf name" />
          </form>
        ) : (
          <button type="button" className="tabs__tab tabs__add" onClick={() => setAdding(true)} aria-label="New shelf" title="New shelf">
            +
          </button>
        )}
      </div>
    </nav>
  );
}
