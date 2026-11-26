// foliate-js ships plain JS modules without types; this is the small part the reader uses.
declare module "foliate-js/view.js" {
  export interface FoliateTocItem {
    label: string;
    href: string;
    subitems?: FoliateTocItem[];
  }
  export interface FoliateLocation {
    fraction: number;
    cfi: string;
    tocItem?: { label: string; href: string };
  }
  export interface FoliateView extends HTMLElement {
    book: { toc?: FoliateTocItem[]; dir?: string };
    renderer: HTMLElement & { setStyles?(css: string): void; next(): Promise<void>; prev(): Promise<void> };
    lastLocation: FoliateLocation | null;
    open(file: File | Blob | string): Promise<void>;
    init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
    goTo(target: string | number): Promise<unknown>;
    goLeft(): Promise<void>;
    goRight(): Promise<void>;
    close(): void;
  }
  export function makeBook(file: File | string): Promise<unknown>;
}
