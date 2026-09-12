// Cache of opened notes: source text, rendered HTML, a live scroll container with
// the note's DOM, and the search index.
//
// Every note keeps its own `.note-scroller` element inside NoteView's host; only the
// active one is visible. Switching notes toggles a class instead of rebuilding or
// re-attaching 10k+ nodes, so wikilink/back navigation is instant and each note keeps
// its exact scroll position and rendering state (content-visibility sizes).
// Non-reactive by design: the zustand store only holds the *current* note.

import * as imageLoader from './imageLoader';

const MAX_ENTRIES = 6;

/** path -> { content, html, scroller: HTMLElement|null, index: Array|null } */
const entries = new Map();

/** Host element that owns the scrollers (set by NoteView) and the active path */
let host = null;
let activePath = null;

/** Store (or refresh) a note. A changed html drops the cached DOM and index. */
export function setNote(path, { content, html }) {
    const existing = entries.get(path);
    if (existing && existing.html === html) {
        existing.content = content;
        touch(path);
        return existing;
    }
    if (existing) dispose(existing);
    const entry = { content, html, scroller: null, index: null };
    entries.delete(path);
    entries.set(path, entry);
    evict();
    return entry;
}

export function getNote(path) {
    const entry = entries.get(path);
    if (entry) touch(path);
    return entry ?? null;
}

/**
 * Show `path` inside `hostEl`: builds the scroller once per html, keeps the others
 * mounted but hidden. Returns the active scroller element.
 */
export function activate(hostEl, path) {
    const entry = entries.get(path);
    if (!entry) return null;
    host = hostEl;
    if (!entry.scroller) {
        const scroller = document.createElement('div');
        scroller.className = 'note-scroller';
        const body = document.createElement('div');
        body.className = 'note-body';
        body.innerHTML = entry.html;
        scroller.appendChild(body);
        entry.scroller = scroller;
        imageLoader.attach(body);
    }
    if (entry.scroller.parentElement !== hostEl) hostEl.appendChild(entry.scroller);
    for (const other of hostEl.children) {
        other.classList.toggle('active', other === entry.scroller);
    }
    activePath = path;
    touch(path);
    return entry.scroller;
}

export function activeScroller() {
    return activePath ? entries.get(activePath)?.scroller ?? null : null;
}

export function currentScrollTop() {
    return activeScroller()?.scrollTop ?? 0;
}

/** Lowercased text of every .patto-line, built once per body. */
export function getSearchIndex(path) {
    const entry = entries.get(path);
    if (!entry || !entry.scroller) return [];
    if (!entry.index) {
        const els = entry.scroller.querySelectorAll('.patto-line');
        const index = new Array(els.length);
        for (let i = 0; i < els.length; i++) {
            index[i] = { el: els[i], idx: els[i].getAttribute('data-line-idx'), text: els[i].textContent.toLowerCase() };
        }
        entry.index = index;
    }
    return entry.index;
}

/** Forget everything (e.g. after a git sync changed files on disk). */
export function clear() {
    for (const entry of entries.values()) dispose(entry);
    entries.clear();
    activePath = null;
}

function dispose(entry) {
    if (entry.scroller) {
        const body = entry.scroller.firstElementChild;
        if (body) imageLoader.detach(body);
        entry.scroller.remove();
        entry.scroller = null;
        entry.index = null;
    }
}

function touch(path) {
    const entry = entries.get(path);
    entries.delete(path);
    entries.set(path, entry);
}

function evict() {
    while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === activePath) break;
        dispose(entries.get(oldest));
        entries.delete(oldest);
    }
}
