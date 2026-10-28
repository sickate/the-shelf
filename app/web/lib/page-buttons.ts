/** Left / right page-turn buttons fixed to the viewport edges of the reading page. */
export interface PageButtonSide {
  /** Same navigation call the arrow keys use. */
  action: () => void;
  /** aria-label, evaluated lazily (RTL books swap the meaning of left / right). */
  label: () => string;
}

export interface PageButtons {
  /** Re-reads labels (call after the book direction becomes known / changes). */
  refresh: () => void;
}

export function mountPageButtons(left: PageButtonSide, right: PageButtonSide): PageButtons {
  document.querySelectorAll(".page-btn").forEach((n) => n.remove());
  const make = (side: "left" | "right", s: PageButtonSide) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `page-btn page-btn-${side}`;
    b.textContent = side === "left" ? "‹" : "›";
    // Keep text selection / focus in the reader when pressing the button.
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => s.action());
    const refresh = () => {
      const t = s.label();
      b.setAttribute("aria-label", t);
      b.title = t;
    };
    for (const ev of ["pointerenter", "focus", "touchstart"]) b.addEventListener(ev, refresh, { passive: true });
    refresh();
    document.body.append(b);
    return refresh;
  };
  const rl = make("left", left);
  const rr = make("right", right);
  return {
    refresh: () => {
      rl();
      rr();
    },
  };
}

/** Plain-text "page": scroll by ~90% of the visible height, minus the bottom audio bar. */
export function scrollPage(dir: 1 | -1): void {
  const audioH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--audio-h")) || 0;
  const amount = Math.max(80, innerHeight * 0.9 - audioH);
  window.scrollBy({ top: dir * amount, behavior: "smooth" });
}
