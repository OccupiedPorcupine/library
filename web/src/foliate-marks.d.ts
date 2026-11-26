// The parts of foliate-js that highlights, notes and bookmarks use (#48).
declare module "foliate-js/view.js" {
  interface FoliateView {
    getCFI(index: number, range?: Range): string;
    addAnnotation(a: { value: string }): Promise<unknown>;
    deleteAnnotation(a: { value: string }): Promise<unknown>;
    deselect(): void;
  }
}

declare module "foliate-js/epubcfi.js" {
  export function collapse(cfi: string, toEnd?: boolean): string;
  export function compare(a: string, b: string): number;
}

declare module "foliate-js/overlayer.js" {
  export type OverlayRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
  export class Overlayer {
    static highlight(rects: OverlayRect[], options?: { color?: string; padding?: number }): SVGElement;
    static underline(rects: OverlayRect[], options?: { color?: string; width?: number; padding?: number }): SVGElement;
  }
}
