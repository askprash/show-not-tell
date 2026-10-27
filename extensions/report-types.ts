/** Shared data contract for recorded evidence and reader-facing walkthroughs. */
export type WalkthroughMode = "verification" | "explanation";

export interface FigureFile {
  path: string;
  sha256: string;
  bytes: number;
  /** figkit lint findings for an SVG made with the bundled library; empty means clean. */
  lint?: string[];
  /** Copy of a figkit SVG with text converted to outlines; this is what the page embeds. */
  outlined?: { path: string; sha256: string; bytes: number };
  /** Why outlining a figkit SVG failed; such a figure cannot be embedded. */
  outline_failed?: string;
}

export interface EvidenceRecord {
  id: string;
  command: string;
  why: string;
  cwd: string;
  started_at: string;
  exit?: number | null;
  stdout?: string;
  stderr?: string;
  ms?: number;
  timed_out?: boolean;
  truncated?: { stdout?: number; stderr?: number };
  at_ref?: string;
  ref_sha?: string;
  overlay?: string[];
  mapped_paths?: boolean;
  produces?: string;
  figures?: FigureFile[];
  produces_missing?: string;
  snapshot?: "before" | "after";
  tree?: Record<string, string>;
  refused?: "budget" | "report-only";
  refused_reason?: string;
}

export interface ScopeRequest {
  label: string;
  head: string;
  base?: string;
  include_working_tree?: boolean;
  record_id?: string;
}

export interface EvidenceItem {
  record_id: string;
  summary: string;
  quote?: string;
}

export interface ReportSection {
  id: string;
  title: string;
  text: string;
  evidence?: EvidenceItem[];
}

export interface CheckResult {
  label: string;
  status: "passed" | "failed" | "blocked" | "not-run" | "inspected";
  summary: string;
  record_ids?: string[];
}

export interface ChangedFile {
  path: string;
  note: string;
  lines?: string;
  record_id?: string;
}

/** Percentages of the diagram image bounds; target is section:<id> or record:<id>. */
export interface DiagramLink {
  label: string;
  target: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualRef {
  record_id: string;
  file?: string;
  kind: "plot" | "diagram";
  caption: string;
  alt?: string;
  section_id?: string;
  links?: DiagramLink[];
}

export interface WritePayload {
  title: string;
  mode: WalkthroughMode;
  scope: ScopeRequest;
  summary: string;
  sections: ReportSection[];
  checks: CheckResult[];
  limits: { text: string; record_id?: string }[];
  changes: ChangedFile[];
  visuals: VisualRef[];
}

export interface ResolvedScope {
  label: string;
  head_sha?: string;
  base_sha?: string;
  include_working_tree: boolean;
  compare_url?: string;
  head_url?: string;
  commits: { sha: string; subject: string; url?: string }[];
  warning?: string;
}

export interface PreparedVisual extends VisualRef {
  src: string;
}

export interface PageMeta {
  repo: string;
  branch: string;
  sha: string;
  dirty: boolean | undefined;
  date: string;
  model?: string;
  cwd: string;
}

export interface PageExtras {
  scope: ResolvedScope;
  visuals: PreparedVisual[];
  autoLimits: { text: string; record_id?: string }[];
  tree?: { checked: boolean; changed: string[]; before_id?: string; after_id?: string };
  fileUrls?: Record<string, string>;
}
