// NoteView component - displays a rendered note with in-page search.
// Each opened note keeps its own scroll container inside the host element (see
// noteCache); switching notes only toggles which one is visible, so navigation is
// instant and scroll positions survive. Images are served by the Rust `pimg` URI
// scheme; large ones are decoded on demand via imageLoader.

import { useStore } from '../lib/store';
import * as noteCache from '../lib/noteCache';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Lightbox } from './Lightbox';
import './NoteView.css';

export function NoteView() {
    const {
        currentNote,
        renderedHtml,
        noteTarget,
        toggleEdit,
        goBack,
        openNote,
        openLightbox,
    } = useStore();

    // Host for the per-note scroll containers (children managed by noteCache, not React)
    const hostRef = useRef(null);
    const [showSearch, setShowSearch] = useState(false);
    const inputRef = useRef(null);

    // Search state: query, current index, cached matching lines, active element
    const searchRef = useRef({ query: '', idx: 0, matches: [], activeEl: null });
    const [displayInfo, setDisplayInfo] = useState('');

    // Show the current note's scroller (built once per rendered HTML)
    useLayoutEffect(() => {
        if (!hostRef.current || !currentNote) return;
        noteCache.activate(hostRef.current, currentNote);

        // Different content: drop stale highlight/search state
        clearHighlights();
        searchRef.current = { query: '', idx: 0, matches: [], activeEl: null };
        setDisplayInfo('');
    }, [currentNote, renderedHtml]);

    // Scroll to the requested position (restored history position or wikilink anchor).
    // Applied twice: immediately and after a frame, once lazily-rendered lines have sized.
    useLayoutEffect(() => {
        const scroller = noteCache.activeScroller();
        if (!scroller || !noteTarget) return;

        const apply = () => {
            if (noteTarget.anchor) {
                const el = scroller.querySelector(`#${CSS.escape(noteTarget.anchor)}`);
                if (el) {
                    el.scrollIntoView({ block: 'start' });
                    return;
                }
            }
            scroller.scrollTop = noteTarget.scrollTop ?? 0;
        };
        apply();
        const frame = requestAnimationFrame(apply);
        return () => cancelAnimationFrame(frame);
    }, [noteTarget, currentNote, renderedHtml]);

    // Handle taps on links and images (delegated; the host element is stable)
    useEffect(() => {
        const scroller = hostRef.current;
        if (!scroller) return;

        const handleClick = async (e) => {
            // Tap on a video thumbnail: load the YouTube player in place
            const facade = e.target.closest('.video-facade');
            if (facade) {
                e.preventDefault();
                const embed = document.createElement('div');
                embed.className = 'video-embed';
                const iframe = document.createElement('iframe');
                iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(facade.dataset.youtubeId)}?autoplay=1`;
                iframe.setAttribute('frameborder', '0');
                iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
                iframe.setAttribute('allowfullscreen', '');
                embed.appendChild(iframe);
                facade.replaceWith(embed);
                return;
            }

            // Tap on an image: show the original in the lightbox
            const img = e.target.closest('img.patto-image');
            if (img) {
                e.preventDefault();
                openLightbox({ src: img.dataset.full || img.currentSrc || img.src, alt: img.alt });
                return;
            }

            const link = e.target.closest('a');
            if (!link) return;

            e.preventDefault();
            const href = link.getAttribute('href');
            if (!href) return;

            if (href.startsWith('http://') || href.startsWith('https://')) {
                try { await openUrl(href); } catch (err) { }
                return;
            }

            const [noteName, anchor] = href.split('#');
            if (noteName) {
                openNote(noteName.endsWith('.pn') ? noteName : `${noteName}.pn`, anchor || null);
            } else if (anchor) {
                // Same-note anchor
                noteCache.activeScroller()?.querySelector(`#${CSS.escape(anchor)}`)?.scrollIntoView({ block: 'start' });
            }
        };

        scroller.addEventListener('click', handleClick);
        return () => scroller.removeEventListener('click', handleClick);
    }, [openNote, openLightbox]);

    // Focus input when search opens
    useEffect(() => {
        if (showSearch && inputRef.current) {
            inputRef.current.focus();
        }
    }, [showSearch]);

    // Clear active search highlight directly
    const clearHighlights = () => {
        if (searchRef.current.activeEl) {
            searchRef.current.activeEl.classList.remove('search-active');
            searchRef.current.activeEl = null;
        }
    };

    // Find all matching lines from the cached in-memory index
    const computeMatches = (query) => {
        if (!query || !currentNote) return [];
        const found = [];
        for (const line of noteCache.getSearchIndex(currentNote)) {
            if (line.text.includes(query)) found.push(line);
        }
        return found;
    };

    // Navigate to index using cached matches in O(1) time
    const navigateToIndex = (idx) => {
        const matches = searchRef.current.matches;
        if (!matches || matches.length === 0) return;

        // Wrap index around total matches
        idx = ((idx % matches.length) + matches.length) % matches.length;
        searchRef.current.idx = idx;

        clearHighlights();

        // Highlight current match (re-find by data-line-idx if the element was replaced)
        const match = matches[idx];
        let el = match.el;
        if (!el || !el.isConnected) {
            el = noteCache.activeScroller()?.querySelector(`[data-line-idx="${match.idx}"]`);
            match.el = el;
        }
        if (el) {
            el.classList.add('search-active');
            searchRef.current.activeEl = el;
            try {
                el.scrollIntoView({ block: 'center', inline: 'nearest' });
            } catch (e) {
                el.scrollIntoView(true);
            }
        }

        setDisplayInfo(`${idx + 1}/${matches.length}`);
    };

    // Find - starts new search and caches matches
    const doFind = () => {
        const query = inputRef.current?.value?.trim().toLowerCase();
        if (!query) {
            clearHighlights();
            searchRef.current = { query: '', idx: 0, matches: [], activeEl: null };
            setDisplayInfo('');
            return;
        }

        clearHighlights();
        const matches = computeMatches(query);
        searchRef.current.query = query;
        searchRef.current.matches = matches;

        if (matches.length > 0) {
            navigateToIndex(0);
        } else {
            searchRef.current.idx = -1;
            setDisplayInfo('0/0');
        }
    };

    const goNext = () => {
        if (!searchRef.current.query || searchRef.current.matches.length === 0) return;
        navigateToIndex(searchRef.current.idx + 1);
    };

    const goPrev = () => {
        if (!searchRef.current.query || searchRef.current.matches.length === 0) return;
        navigateToIndex(searchRef.current.idx - 1);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const currentQuery = inputRef.current?.value?.trim().toLowerCase();
            if (currentQuery !== searchRef.current.query) {
                doFind();
            } else if (searchRef.current.matches.length > 0) {
                if (e.shiftKey) {
                    goPrev();
                } else {
                    goNext();
                }
            } else {
                doFind();
            }
        } else if (e.key === 'Escape') {
            closeSearch();
        }
    };

    const closeSearch = () => {
        setShowSearch(false);
        clearHighlights();
        searchRef.current = { query: '', idx: 0, matches: [], activeEl: null };
        setDisplayInfo('');
    };

    const noteName = currentNote?.replace(/\.pn$/, '') || 'Note';

    return (
        <div className="note-view">
            <header className="note-header">
                <button className="back-btn" onClick={goBack}>← Back</button>
                <h1 className="note-title">{noteName}</h1>
                <button className="edit-btn" onClick={toggleEdit}>Edit</button>
            </header>

            {!showSearch && (
                <button className="search-toggle-btn" onClick={() => setShowSearch(true)}>🔍</button>
            )}

            {/* The search bar overlays the content instead of pushing it down: resizing a
                10k+-line note costs hundreds of ms per frame. */}
            <div className={`note-body-area${showSearch ? ' searching' : ''}`}>
                {showSearch && (
                    <div className="search-bar">
                        <input
                            ref={inputRef}
                            type="text"
                            className="search-input"
                            placeholder="Search..."
                            onKeyDown={handleKeyDown}
                        />
                        <button type="button" className="search-action-btn" onClick={doFind}>🔍</button>
                        <span className="match-info">{displayInfo}</span>
                        <button type="button" className="search-action-btn" onClick={goPrev}>↑</button>
                        <button type="button" className="search-action-btn" onClick={goNext}>↓</button>
                        <button type="button" className="search-close-btn" onClick={closeSearch}>✕</button>
                    </div>
                )}

                {/* Children (one scroller per cached note) are managed by noteCache; keep this element childless in JSX */}
                <div ref={hostRef} className="note-content" />
            </div>

            <Lightbox />
        </div>
    );
}
