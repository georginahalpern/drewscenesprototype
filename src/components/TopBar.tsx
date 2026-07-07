import { useEffect, useRef, useState } from 'react';

export type Theme = 'dark' | 'light';

/** Top-level workspace mode. Drives both the title prefix and which side
 *  panels are visible. The Ontology Editor is the authoring surface for
 *  the shared ontology; Scene Editor / Viewer compose scene files (JSON
 *  with conditions + selected instances) on top of an unchanged ontology. */
export type AppMode = 'ontology' | 'scene-editor' | 'scene-viewer' | 'babylon-lite-demo';

const MODE_LABELS: Record<AppMode, string> = {
  'ontology': 'Ontology Editor',
  'scene-editor': 'Scene Editor',
  'scene-viewer': 'Scene Viewer',
  'babylon-lite-demo': 'Babylon Lite Demo'
};

const MODE_TITLE_PREFIX: Record<AppMode, string> = {
  'ontology': 'Editing ontology:\u00a0',
  'scene-editor': 'Editing scene:\u00a0',
  'scene-viewer': 'Viewing scene:\u00a0',
  'babylon-lite-demo': 'Babylon Lite demo:\u00a0'
};

interface Props {
  sceneName: string;
  onSceneNameChange: (name: string) => void;
  onExport: () => void;
  onImport: (file: File) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
}

export default function TopBar({
  sceneName,
  onSceneNameChange,
  onExport,
  onImport,
  theme,
  onThemeChange,
  mode,
  onModeChange
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sceneName);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(sceneName);
  }, [sceneName, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Close the settings menu when clicking outside it or pressing Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(ev.target as Node)) return;
      setMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const commit = () => {
    const next = draft.trim() || sceneName;
    if (next !== sceneName) onSceneNameChange(next);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(sceneName);
    setEditing(false);
  };

  const onPickFile: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const f = e.target.files?.[0];
    if (f) onImport(f);
    e.target.value = '';
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        {editing ? (
          <input
            ref={inputRef}
            className="scene-title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') cancel();
            }}
            maxLength={120}
          />
        ) : (
          <button
            type="button"
            className="scene-title-btn"
            title="Click to rename scene"
            onClick={() => setEditing(true)}
          >
            <span className="scene-title-prefix">{MODE_TITLE_PREFIX[mode]}</span>
            <span className="scene-title-text">{sceneName}</span>
            <PencilIcon />
          </button>
        )}
      </div>
      <div className="topbar-center" role="tablist" aria-label="Workspace mode">
        {(['ontology', 'scene-editor', 'scene-viewer', 'babylon-lite-demo'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`mode-btn${mode === m ? ' is-active' : ''}`}
            onClick={() => onModeChange(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <div className="topbar-right">
        <input
          ref={fileRef}
          type="file"
          accept=".json,.usda,.usd,application/json,text/plain"
          style={{ display: 'none' }}
          onChange={onPickFile}
        />
        <button
          type="button"
          className="topbar-btn"
          onClick={() => fileRef.current?.click()}
          title="Load a scene from a combined .json file (or legacy .usda)"
        >
          <LoadIcon />
          <span>Load</span>
        </button>
        <button
          type="button"
          className="topbar-btn is-primary"
          onClick={onExport}
          title="Save scene + ontology as a combined .json file"
        >
          <SaveIcon />
          <span>Save</span>
        </button>
        <div className="topbar-menu" ref={menuRef}>
          <button
            type="button"
            className={`topbar-icon-btn${menuOpen ? ' is-open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title="Settings"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <HamburgerIcon />
          </button>
          {menuOpen && (
            <div className="topbar-dropdown" role="menu">
              <div className="dropdown-section-label">Theme</div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={theme === 'dark'}
                className={`dropdown-item${theme === 'dark' ? ' is-active' : ''}`}
                onClick={() => {
                  onThemeChange('dark');
                  setMenuOpen(false);
                }}
              >
                <MoonIcon />
                <span>Dark</span>
                {theme === 'dark' && <CheckIcon />}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={theme === 'light'}
                className={`dropdown-item${theme === 'light' ? ' is-active' : ''}`}
                onClick={() => {
                  onThemeChange('light');
                  setMenuOpen(false);
                }}
              >
                <SunIcon />
                <span>Light</span>
                {theme === 'light' && <CheckIcon />}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 20 L4 16 L16 4 L20 8 L8 20 Z" />
      <path d="M14 6 L18 10" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Floppy-disk outline with notched top-right corner. */}
      <path d="M5 4 H16 L20 8 V19 A1 1 0 0 1 19 20 H5 A1 1 0 0 1 4 19 V5 A1 1 0 0 1 5 4 Z" />
      {/* Top label slot. */}
      <path d="M8 4 V9 H15 V4" />
      {/* Bottom write-protect/label rectangle. */}
      <path d="M7 13 H17 V20 H7 Z" />
    </svg>
  );
}

function LoadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Open folder: back panel with tab, slanted front flap. */}
      <path d="M3 7 A1 1 0 0 1 4 6 H9 L11 8 H19 A1 1 0 0 1 20 9 V10" />
      <path d="M3 10 H21 L18.5 19 A1 1 0 0 1 17.5 20 H4.5 A1 1 0 0 1 3.5 19 Z" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M4 7 L20 7" />
      <path d="M4 12 L20 12" />
      <path d="M4 17 L20 17" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 14.5 A8 8 0 1 1 9.5 4 A6 6 0 0 0 20 14.5 Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3 L12 5" />
      <path d="M12 19 L12 21" />
      <path d="M3 12 L5 12" />
      <path d="M19 12 L21 12" />
      <path d="M5.6 5.6 L7 7" />
      <path d="M17 17 L18.4 18.4" />
      <path d="M5.6 18.4 L7 17" />
      <path d="M17 7 L18.4 5.6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="dropdown-check"
    >
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}
