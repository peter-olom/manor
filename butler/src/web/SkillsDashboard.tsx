import { useEffect, useMemo, useState, type MouseEvent } from "react";

import { deleteJson, getJson, postJson, putJson } from "./api";
import { dispatchSkillInstallHandoff } from "./skill-install-handoff";

type EnvironmentId = "butler-pi" | "worker-pi";
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
type UnifiedSkillItem = SkillItem & { registryKey: string; environments: EnvironmentId[] };
type UnifiedSkillDetail = SkillDetail & { environments: EnvironmentId[] };
const MAX_SKILL_ARCHIVE_BYTES = 10 * 1024 * 1024;
const SKILL_ENVIRONMENTS: readonly EnvironmentId[] = ["butler-pi", "worker-pi"];
const REGISTRY_MUTATION_ENVIRONMENT: EnvironmentId = "butler-pi";

export function mergeSkillCatalogs(catalogs: SkillItem[][]): UnifiedSkillItem[] {
  const merged = new Map<string, UnifiedSkillItem>();
  for (const skill of catalogs.flat()) {
    const registryKey = skill.name.toLowerCase();
    const existing = merged.get(registryKey);
    if (!existing) {
      merged.set(registryKey, { ...skill, registryKey, environments: [skill.environment] });
      continue;
    }
    const environments = [...new Set([...existing.environments, skill.environment])];
    const preferCurrent = (!existing.mutable && skill.mutable)
      || (existing.mutable === skill.mutable && existing.environment === "worker-pi" && skill.environment === "butler-pi");
    merged.set(registryKey, preferCurrent
      ? { ...skill, registryKey, environments }
      : { ...existing, environments });
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function availabilityLabel(environments: EnvironmentId[]): string {
  if (environments.length === 2) return "Butler & Worker";
  return environments[0] === "butler-pi" ? "Butler" : "Worker";
}

function sourceLabel(skill: SkillItem): string {
  if (skill.origin === "package") return "Package";
  if (skill.origin === "system") return "Built in";
  return skill.scope === "project" ? "Workspace" : "Shared registry";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let output = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(output);
}

export function SkillsDashboard({ active }: { active: boolean }) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UnifiedSkillDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [cwd, setCwd] = useState("/repos");
  const [scope] = useState<"user">("user");
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createInstructions, setCreateInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const query = `?cwd=${encodeURIComponent(cwd.trim() || "/repos")}`;
  async function loadCatalog() {
    setLoading(true);
    try {
      const catalogs = await Promise.all(SKILL_ENVIRONMENTS.map(async (environment) => (
        await getJson<{ skills: SkillItem[] }>(`/api/skills/${environment}${query}`)
      ).skills));
      const nextSkills = catalogs.flat();
      const nextRegistry = mergeSkillCatalogs(catalogs);
      setSkills(nextSkills);
      setSelectedId((current) => nextRegistry.some((skill) => skill.registryKey === current) ? current : null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    setError(null);
    void loadCatalog().catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, [active]);

  const registry = useMemo(() => mergeSkillCatalogs([
    skills.filter((skill) => skill.environment === "butler-pi"),
    skills.filter((skill) => skill.environment === "worker-pi")
  ]), [skills]);

  useEffect(() => {
    if (!active || !selectedId) {
      setDetail(null);
      setDraft("");
      return;
    }
    const selected = registry.find((skill) => skill.registryKey === selectedId);
    if (!selected) return;
    void getJson<{ skill: SkillDetail }>(`/api/skills/${selected.environment}/${encodeURIComponent(selected.id)}${query}`)
      .then(({ skill }) => { setDetail({ ...skill, environments: selected.environments }); setDraft(skill.content); })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, [active, query, registry, selectedId]);

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
    return needle ? registry.filter((skill) => `${skill.name} ${skill.description} ${skill.origin} ${availabilityLabel(skill.environments)}`.toLowerCase().includes(needle)) : registry;
  }, [search, registry]);

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
        environment: REGISTRY_MUTATION_ENVIRONMENT,
        name: createName,
        description: createDescription,
        instructions: createInstructions,
        scope,
        cwd
      });
      await loadCatalog();
      setSelectedId(payload.skill.name.toLowerCase());
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
      await putJson(`/api/skills/${detail.environment}/${encodeURIComponent(detail.id)}`, { content: draft, cwd });
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
      await deleteJson(`/api/skills/${detail.environment}/${encodeURIComponent(detail.id)}${query}`);
      setSelectedId(null);
      await loadCatalog();
      setFeedback(`${detail.name} was deleted.`);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setBusy(false); }
  }

  async function importArchive(file: File) {
    if (busy) return;
    setBusy(true); setError(null); setFeedback(null);
    try {
      const archive = await file.slice(0, MAX_SKILL_ARCHIVE_BYTES + 1).arrayBuffer();
      if (archive.byteLength > MAX_SKILL_ARCHIVE_BYTES) throw new Error("Skill archive must be 10 MB or smaller.");
      await postJson("/api/skills/import", { environment: REGISTRY_MUTATION_ENVIRONMENT, scope, cwd, archiveBase64: arrayBufferToBase64(archive) });
      await loadCatalog();
      setFeedback(`${file.name} was installed.`);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setBusy(false); }
  }

  return (
    <section className={`skills-dashboard${active ? " is-active" : ""}`} aria-label="Skills settings">
      <header className="skills-head">
        <div><span className="eyebrow">Agent capabilities</span><h1>Skills</h1><p>Butler and Worker use one shared skill registry. Built-in and package skills appear once with where they can be used.</p></div>
        <a className="button is-primary skills-ask-butler" href="/?ask=add-skill" onClick={askButler}>Ask Butler to add a skill</a>
      </header>
      <div className="skills-toolbar">
        <input className="input" type="search" aria-label="Search installed skills" placeholder="Search installed skills" value={search} onChange={(event) => setSearch(event.target.value)} />
        <span className="skills-count">{visible.length} {visible.length === 1 ? "skill" : "skills"}</span>
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      {feedback ? <div className="skills-feedback" role="status">{feedback}</div> : null}
      <div className="skills-inventory" role="list">
        {!loading && visible.length > 0 ? <div className="skills-inventory-head" aria-hidden="true"><span>Skill</span><span>Use in chat</span><span>Available to</span><span /></div> : null}
        {visible.map((skill) => (
          <div className="skills-inventory-row" role="listitem" key={skill.registryKey}>
            <span className="skills-inventory-main"><strong>{skill.name}</strong><small>{skill.description || "No description"}</small></span>
            <code>{skill.invocation}</code>
            <span className="skills-inventory-meta">{availabilityLabel(skill.environments)}<small>{sourceLabel(skill)}{skill.mutable ? "" : " · read-only"}</small></span>
            <button className="button" type="button" onClick={() => { setCreating(false); setSelectedId(skill.registryKey); }}><span className="skills-view-details">View details</span><span className="skills-view-short">View</span></button>
          </div>
        ))}
        {loading ? <div className="skills-empty" role="status"><strong>Loading skills…</strong></div> : null}
        {!loading && visible.length === 0 ? <div className="skills-empty"><strong>{search.trim() ? "No skills match your search." : "No installed skills found."}</strong><span>Ask Butler to find one for the work you need to do.</span><a className="button is-primary" href="/?ask=add-skill" onClick={askButler}>Ask Butler</a></div> : null}
      </div>
      <details className="skills-advanced">
        <summary>Advanced</summary>
        <div className="skills-advanced-body">
          <div><h2>Manual skill management</h2><p>Manual changes publish to the shared registry. Ask Butler to install or update skills from repositories.</p></div>
          <div className="skills-workspace">
            <label>Workspace<input className="input" value={cwd} onChange={(event) => setCwd(event.target.value)} onBlur={() => void loadCatalog()} /></label>
            <label>Install scope<select className="input" value={scope} disabled><option value="user">Shared user registry</option></select></label>
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
          <div className="skills-dialog-head"><div><span className="eyebrow">{sourceLabel(detail)} · {availabilityLabel(detail.environments)}</span><h2 id="skill-detail-title">{detail.name}</h2><p>{detail.description}</p></div><button className="icon-button" type="button" aria-label="Close" autoFocus onClick={() => setSelectedId(null)}>×</button></div>
          <div className="skills-invocation"><span>Use in chat</span><code>{detail.invocation}</code></div>
          <label>Instructions<textarea className="input skills-content" value={draft} readOnly={!detail.mutable} onChange={(event) => setDraft(event.target.value)} aria-label={`${detail.name} skill content`} /></label>
          {!detail.mutable ? <p className="muted">Package, system, and repository skills are read-only here.</p> : null}
          <div className="skills-editor-actions"><button className="button is-danger" type="button" disabled={!detail.mutable || busy} onClick={() => void removeSkill()}>Delete skill</button><button className="button is-primary" type="button" disabled={!detail.mutable || busy || draft === detail.content} onClick={() => void saveSkill()}>Save changes</button></div>
        </> : <div className="skills-dialog-loading">Loading skill…</div>}
      </section></div> : null}
    </section>
  );
}
