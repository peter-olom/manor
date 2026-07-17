import { useEffect, useMemo, useState, type MouseEvent } from "react";

import { deleteJson, getJson, postJson, putJson } from "./api";
import { dispatchSkillInstallHandoff } from "./skill-install-handoff";

type EnvironmentId = "butler-pi" | "worker-pi" | "worker-codex";
type SkillEnvironment = {
  id: EnvironmentId;
  label: string;
  harness: "pi" | "codex";
  capabilities: { create: boolean; import: boolean; packageManagement: false };
};
type SkillItem = {
  id: string;
  environment: EnvironmentId;
  name: string;
  description: string;
  scope: "user" | "project";
  origin: "local" | "package" | "system";
  mutable: boolean;
  invocation: string;
};
type SkillDetail = SkillItem & { content: string };

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let output = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(output);
}

export function SkillsDashboard({ active }: { active: boolean }) {
  const [environments, setEnvironments] = useState<SkillEnvironment[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentId>("butler-pi");
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [cwd, setCwd] = useState("/repos");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createInstructions, setCreateInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const query = `?cwd=${encodeURIComponent(cwd.trim() || "/repos")}`;
  async function loadCatalog(nextEnvironment = environment) {
    const payload = await getJson<{ skills: SkillItem[] }>(`/api/skills/${nextEnvironment}${query}`);
    setSkills(payload.skills);
    setSelectedId((current) => payload.skills.some((skill) => skill.id === current) ? current : null);
  }

  useEffect(() => {
    if (!active) return;
    void getJson<{ environments: SkillEnvironment[] }>("/api/skills/environments")
      .then((payload) => setEnvironments(payload.environments))
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, [active]);

  useEffect(() => {
    if (!active) return;
    setError(null);
    void loadCatalog().catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, [active, environment]);

  useEffect(() => {
    if (!active || !selectedId) {
      setDetail(null);
      setDraft("");
      return;
    }
    void getJson<{ skill: SkillDetail }>(`/api/skills/${environment}/${encodeURIComponent(selectedId)}${query}`)
      .then(({ skill }) => { setDetail(skill); setDraft(skill.content); })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, [active, environment, query, selectedId]);

  useEffect(() => {
    if (!creating && !selectedId) return;
    function closeDialog(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setCreating(false);
      setSelectedId(null);
    }
    document.addEventListener("keydown", closeDialog);
    return () => document.removeEventListener("keydown", closeDialog);
  }, [creating, selectedId]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? skills.filter((skill) => `${skill.name} ${skill.description} ${skill.origin}`.toLowerCase().includes(needle)) : skills;
  }, [search, skills]);

  function askButler(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    dispatchSkillInstallHandoff();
  }

  async function createSkill() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const payload = await postJson<{ skill: SkillItem }>("/api/skills", {
        environment,
        name: createName,
        description: createDescription,
        instructions: createInstructions,
        scope,
        cwd
      });
      await loadCatalog();
      setSelectedId(payload.skill.id);
      setCreating(false);
      setCreateName(""); setCreateDescription(""); setCreateInstructions("");
      setFeedback(`${payload.skill.name} is installed and ready to use.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function saveSkill() {
    if (!detail || !detail.mutable || busy) return;
    setBusy(true); setError(null); setFeedback(null);
    try {
      await putJson(`/api/skills/${environment}/${encodeURIComponent(detail.id)}`, { content: draft, cwd });
      await loadCatalog();
      setDetail({ ...detail, content: draft });
      setFeedback(`${detail.name} was updated.`);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setBusy(false); }
  }

  async function removeSkill() {
    if (!detail || !detail.mutable || busy || !window.confirm(`Delete ${detail.name}?`)) return;
    setBusy(true); setError(null); setFeedback(null);
    try {
      await deleteJson(`/api/skills/${environment}/${encodeURIComponent(detail.id)}${query}`);
      setSelectedId(null);
      await loadCatalog();
      setFeedback(`${detail.name} was deleted.`);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setBusy(false); }
  }

  async function importArchive(file: File) {
    if (busy) return;
    if (file.size > 10 * 1024 * 1024) { setError("Skill archive must be 10 MB or smaller."); return; }
    setBusy(true); setError(null); setFeedback(null);
    try {
      await postJson("/api/skills/import", { environment, scope, cwd, archiveBase64: arrayBufferToBase64(await file.arrayBuffer()) });
      await loadCatalog();
      setFeedback(`${file.name} was installed.`);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setBusy(false); }
  }

  return (
    <section className={`skills-dashboard${active ? " is-active" : ""}`} aria-label="Skills settings">
      <header className="skills-head">
        <div><span className="eyebrow">Agent capabilities</span><h1>Skills</h1><p>See what your agents can do and where each skill is available.</p></div>
        <a className="button is-primary skills-ask-butler" href="/?ask=add-skill" onClick={askButler}>Ask Butler to add a skill</a>
      </header>
      <nav className="skills-environments" aria-label="Skill environments">
        {environments.map((entry) => <button key={entry.id} className={entry.id === environment ? "is-active" : ""} type="button" onClick={() => { setEnvironment(entry.id); setSelectedId(null); }}>{entry.label} <span>{entry.harness}</span></button>)}
      </nav>
      <div className="skills-toolbar">
        <input className="input" type="search" aria-label="Search installed skills" placeholder="Search installed skills" value={search} onChange={(event) => setSearch(event.target.value)} />
        <span className="skills-count">{visible.length} {visible.length === 1 ? "skill" : "skills"}</span>
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      {feedback ? <div className="skills-feedback" role="status">{feedback}</div> : null}
      <div className="skills-inventory" role="list">
        {visible.length > 0 ? <div className="skills-inventory-head" aria-hidden="true"><span>Skill</span><span>Use in chat</span><span>Scope</span><span /></div> : null}
        {visible.map((skill) => (
          <div className="skills-inventory-row" role="listitem" key={skill.id}>
            <span className="skills-inventory-main"><strong>{skill.name}</strong><small>{skill.description || "No description"}</small></span>
            <code>{skill.invocation}</code>
            <span className="skills-inventory-meta">{skill.scope}<small>{skill.origin}{skill.mutable ? "" : " · read-only"}</small></span>
            <button className="button" type="button" onClick={() => { setCreating(false); setSelectedId(skill.id); }}><span className="skills-view-details">View details</span><span className="skills-view-short">View</span></button>
          </div>
        ))}
        {visible.length === 0 ? <div className="skills-empty"><strong>No installed skills found.</strong><span>Ask Butler to find one for the work you need to do.</span><a className="button is-primary" href="/?ask=add-skill" onClick={askButler}>Ask Butler</a></div> : null}
      </div>
      <details className="skills-advanced">
        <summary>Advanced</summary>
        <div className="skills-advanced-body">
          <div><h2>Manual skill management</h2><p>Choose a destination before creating a skill or installing a trusted archive.</p></div>
          <div className="skills-workspace">
            <label>Workspace<input className="input" value={cwd} onChange={(event) => setCwd(event.target.value)} onBlur={() => void loadCatalog()} /></label>
            <label>Install scope<select className="input" value={scope} onChange={(event) => setScope(event.target.value as "user" | "project")}><option value="user">User</option><option value="project">Project</option></select></label>
          </div>
          <div className="skills-advanced-actions">
            <button className="button" type="button" onClick={() => { setSelectedId(null); setCreating(true); }}>Create manually</button>
            <label className="button skills-import">Install archive<input type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importArchive(file); event.currentTarget.value = ""; }} /></label>
          </div>
        </div>
      </details>
      {creating ? <div className="skills-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setCreating(false); }}><section className="skills-dialog" role="dialog" aria-modal="true" aria-labelledby="new-skill-title">
        <div className="skills-dialog-head"><div><span className="eyebrow">Advanced</span><h2 id="new-skill-title">Create a skill manually</h2></div><button className="icon-button" type="button" aria-label="Close" onClick={() => setCreating(false)}>×</button></div>
        <label>Name<input className="input" value={createName} placeholder="review-release" autoFocus onChange={(event) => setCreateName(event.target.value)} /></label>
        <label>Description<input className="input" value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} /></label>
        <label>Instructions<textarea className="input" value={createInstructions} onChange={(event) => setCreateInstructions(event.target.value)} /></label>
        <div className="skills-editor-actions"><button className="button" type="button" onClick={() => setCreating(false)}>Cancel</button><button className="button is-primary" type="button" disabled={busy || !createName || !createDescription} onClick={() => void createSkill()}>Create skill</button></div>
      </section></div> : null}
      {selectedId ? <div className="skills-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelectedId(null); }}><section className="skills-dialog is-detail" role="dialog" aria-modal="true" aria-label="Skill details">
        {detail ? <>
          <div className="skills-dialog-head"><div><span className="eyebrow">{detail.scope} · {detail.origin}</span><h2 id="skill-detail-title">{detail.name}</h2><p>{detail.description}</p></div><button className="icon-button" type="button" aria-label="Close" autoFocus onClick={() => setSelectedId(null)}>×</button></div>
          <div className="skills-invocation"><span>Use in chat</span><code>{detail.invocation}</code></div>
          <label>Instructions<textarea className="input skills-content" value={draft} readOnly={!detail.mutable} onChange={(event) => setDraft(event.target.value)} aria-label={`${detail.name} skill content`} /></label>
          {!detail.mutable ? <p className="muted">Package and system skills are read-only.</p> : null}
          <div className="skills-editor-actions"><button className="button is-danger" type="button" disabled={!detail.mutable || busy} onClick={() => void removeSkill()}>Delete skill</button><button className="button is-primary" type="button" disabled={!detail.mutable || busy || draft === detail.content} onClick={() => void saveSkill()}>Save changes</button></div>
        </> : <div className="skills-dialog-loading">Loading skill…</div>}
      </section></div> : null}
    </section>
  );
}
