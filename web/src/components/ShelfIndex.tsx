import { useEffect, useState } from "react";

interface Props {
  shelves: { id: string; name: string; count: number }[];
  onCreate: (name: string) => void;
}

/**
 * The vertical element: a gallery-style index of themes down the side.
 * Highlights the shelf in view; clicking glides to it.
 */
export function ShelfIndex({ shelves, onCreate }: Props) {
  const [active, setActive] = useState<string | undefined>(shelves[0]?.id);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const els = shelves.map((s) => document.getElementById(`shelf-${s.id}`)).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive((vis[0].target as HTMLElement).dataset.shelf);
      },
      { rootMargin: "-30% 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [shelves]);

  return (
    <nav className="index" aria-label="Shelves">
      <p className="index__label">Shelves</p>
      <ol className="index__list">
        {shelves.map((s, i) => (
          <li key={s.id}>
            <a
              href={`#shelf-${s.id}`}
              className={`index__item${active === s.id ? " is-active" : ""}`}
              aria-current={active === s.id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(`shelf-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                setActive(s.id);
              }}
            >
              <span className="index__num">{String(i + 1).padStart(2, "0")}</span>
              <span className="index__name">{s.name}</span>
              <span className="index__count">{s.count}</span>
            </a>
          </li>
        ))}
      </ol>
      {adding ? (
        <form
          className="index__new"
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
        <button type="button" className="index__add" onClick={() => setAdding(true)}>
          + New shelf
        </button>
      )}
    </nav>
  );
}
