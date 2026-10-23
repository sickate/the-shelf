import { api } from "../lib/api";
import { applyCatalogVisibility } from "../lib/catalog-visibility.mjs";

export function initCatalog() {
  const data = JSON.parse(
    document.getElementById("catalog-data")!.textContent!,
  );
  const search = document.getElementById("search") as HTMLInputElement,
    format = document.getElementById("format") as HTMLSelectElement,
    status = document.getElementById("status") as HTMLSelectElement,
    category = document.getElementById("category") as HTMLSelectElement;
  let page = 1;
  let visibleBooks = data;
  const perPage = 24;
  const params = new URLSearchParams(location.search);
  search.value = params.get("q") || "";
  category.value = params.get("category") || "";
  format.value = params.get("format") || "";
  status.value = params.get("status") || "";
  const cards = new Map(
    Array.from(document.querySelectorAll<HTMLElement>(".book-card")).map(
      (c) => [c.dataset.id, c],
    ),
  );
  function render() {
    document.getElementById("catalog-total")!.textContent =
      visibleBooks.length.toLocaleString();
    document.getElementById("catalog-all-count")!.textContent = String(
      visibleBooks.length,
    );
    document
      .querySelectorAll<HTMLElement>("[data-category-count]")
      .forEach((count) => {
        count.textContent = String(
          visibleBooks.filter(
            (book: any) => book.categoryId === count.dataset.categoryCount,
          ).length,
        );
      });
    const q = search.value.trim().toLocaleLowerCase();
    const filtered = visibleBooks
      .filter(
        (b: any) =>
          (!q ||
            [b.title, b.author, b.description, ...b.tags]
              .join(" ")
              .toLocaleLowerCase()
              .includes(q)) &&
          (!category.value || b.categoryId === category.value) &&
          (!format.value ||
            b.files.some((f: any) => f.format === format.value)) &&
          (!status.value ||
            b.files.some((f: any) => f.status === status.value)),
      )
      .sort((a: any, b: any) => a.title.localeCompare(b.title, "zh-CN"));
    const pages = Math.max(1, Math.ceil(filtered.length / perPage));
    page = Math.min(page, pages);
    cards.forEach((c) => (c.hidden = true));
    filtered.slice((page - 1) * perPage, page * perPage).forEach((b: any) => {
      const c = cards.get(b.id)!;
      c.hidden = false;
      document.getElementById("books")!.appendChild(c);
    });
    document.getElementById("empty")!.hidden = filtered.length > 0;
    document.getElementById("count")!.textContent =
      `${filtered.length} 本藏书${filtered.length ? ` · 第 ${page} / ${pages} 页` : ""}`;
    document
      .querySelectorAll<HTMLElement>("[data-category]")
      .forEach((c) =>
        c.classList.toggle("active", c.dataset.category === category.value),
      );
    const nav = document.getElementById("pagination")!;
    nav.replaceChildren();
    if (pages > 1) {
      for (const n of Array.from(new Set([1, page - 1, page, page + 1, pages]))
        .filter((n) => n >= 1 && n <= pages)
        .sort((a, b) => a - b)) {
        const button = document.createElement("button");
        button.textContent = String(n);
        button.setAttribute("aria-label", `第 ${n} 页`);
        if (n === page) button.setAttribute("aria-current", "page");
        button.onclick = () => {
          page = n;
          render();
          document
            .getElementById("filters")!
            .scrollIntoView({ block: "start", behavior: "smooth" });
        };
        nav.append(button);
      }
    }
    const next = new URLSearchParams();
    if (search.value) next.set("q", search.value);
    if (category.value) next.set("category", category.value);
    if (format.value) next.set("format", format.value);
    if (status.value) next.set("status", status.value);
    history.replaceState(
      null,
      "",
      location.pathname + (next.size ? "?" + next : ""),
    );
  }
  for (const el of [search, format, status, category])
    el.addEventListener("input", () => {
      page = 1;
      render();
    });
  document.querySelectorAll<HTMLAnchorElement>("[data-category]").forEach(
    (a) =>
      (a.onclick = (e) => {
        e.preventDefault();
        category.value = a.dataset.category!;
        page = 1;
        render();
      }),
  );
  document.getElementById("filters")!.onsubmit = (e) => e.preventDefault();
  document.getElementById("clear")!.onclick = () => {
    search.value = format.value = status.value = category.value = "";
    page = 1;
    render();
  };
  render();
  if (import.meta.env.PUBLIC_SHELF_API_MODE === "same-origin") {
    void api("/api/catalog-state")
      .then((snapshot) => {
        const result = applyCatalogVisibility(data, snapshot);
        visibleBooks = result.books;
        document.getElementById("catalog-state-status")!.hidden =
          result.available;
        page = 1;
        render();
      })
      .catch(() => {
        document.getElementById("catalog-state-status")!.hidden = false;
      });
  }
}
