// Forge: a standalone GitHub-compatible git forge in one Node 22 process (stdlib only).
// Serves git smart HTTP (upload-pack v2, receive-pack v0), REST v3 under /api/v3,
// GraphQL v4 at /api/graphql and MCP (Streamable HTTP) at /mcp, from one in-memory
// store with a real SHA-1 object model (loose objects + pack read/write, no git binary).
//
// Lifecycle (the harness's contract): bind an ephemeral port, POST {"port": N} to
// $MAKEFUN_ENV_URL/register, long-poll GET $MAKEFUN_ENV_URL/done, exit 0 when done.
//
// Auth: every API call carries Authorization: Bearer $MAKEFUN_SHOP_TOKEN. The token
// names the scenario viewer; the kit's scenario seed is a fixed constant, so the
// viewer login is the fixed "adaiversen" (stranger "olgabauer" owns nothing here).
// A repository belongs to the viewer: the same name under another owner is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0'.repeat(40);
const SHA_RE = /^[0-9a-f]{40}$/;
const AGENT = 'forge/1.0.0';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

let reqCounter = 0;
let commitCounter = 0;
let repoSeq = 0;
const BASE_EPOCH = 1735689600; // 2025-01-01T00:00:00Z; deterministic, never the wall clock.

function nextEpoch(): number {
  commitCounter += 1;
  return BASE_EPOCH + commitCounter;
}
function isoOf(seq: number): string {
  return new Date((BASE_EPOCH + seq) * 1000).toISOString();
}
function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function reqId(): string {
  reqCounter += 1;
  return `forge-${process.pid.toString(16)}-${reqCounter.toString(16)}-${Date.now().toString(16)}`;
}
function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}
function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Git object model
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}
function buildCommit(fields: { tree: string; parents: string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const stamp = `${fields.timestamp} +0000`;
  let out = `tree ${fields.tree}\n`;
  for (const p of fields.parents) out += `parent ${p}\n`;
  out += `author ${fields.author} ${stamp}\ncommitter ${fields.committer} ${stamp}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const out = { object: '', type: '', tag: '', tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}
const IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

// ---------------------------------------------------------------------------
// Packfiles (plain objects plus REF/OFS delta resolution on read)
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const first = (typeNum[type] << 4) | (size & 0x0f);
  const bytes: number[] = [];
  let rest = size >> 4;
  if (rest === 0) {
    bytes.push(first);
  } else {
    bytes.push(first | 0x80);
    while (rest > 0) {
      const b = rest & 0x7f;
      rest >>= 7;
      bytes.push(rest === 0 ? b : b | 0x80);
    }
  }
  return Buffer.from(bytes);
}
function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const ver = Buffer.alloc(4);
  ver.writeUInt32BE(2, 0);
  parts.push(ver);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}
function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = start + 1;
  while (byte & 0x80) {
    byte = buf[pos];
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next: pos, first };
}
function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let pos = start + 1;
  let offset = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[pos];
    pos += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: offset, next: pos };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos];
      pos += 1;
      out |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return out;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) { off |= delta[pos] << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) { size |= delta[pos] << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(off, off + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}
interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}
function readPack(pack: Buffer): PackEntry[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  const pending: { offset: number; type: number; data: Buffer; baseOid?: string; baseOffset?: number }[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const { size, next, first } = readVarintSize(pack, off);
    off = next;
    let typeNum = first;
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      const r = readOfsDeltaBase(pack, off);
      baseOffset = entryOffset - r.baseOffset;
      off = r.next;
    } else if (typeNum === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const start = off;
    const inflated = inflateSync(pack.subarray(start));
    const consumed = inflateConsumed(pack.subarray(start));
    off = start + consumed;
    pending.push({ offset: entryOffset, type: typeNum, data: inflated, baseOid, baseOffset });
    void size;
  }
  const typeName: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (const p of pending) {
    if (typeName[p.type] !== undefined) {
      const type = typeName[p.type];
      const oid = hashObject(type, p.data);
      const entry: PackEntry = { type, data: p.data, oid };
      entries.push(entry);
      byOffset.set(p.offset, entry);
      byOid.set(oid, entry);
    }
  }
  // resolve deltas (may need multiple passes for delta chains)
  for (let round = 0; round < pending.length + 1; round++) {
    let progressed = false;
    for (const p of pending) {
      if (typeName[p.type] !== undefined) continue;
      const base = p.baseOid !== undefined ? byOid.get(p.baseOid) : p.baseOffset !== undefined ? byOffset.get(p.baseOffset) : undefined;
      if (!base) continue;
      const data = applyDelta(base.data, p.data);
      const entry: PackEntry = { type: base.type, data, oid: hashObject(base.type, data) };
      entries.push(entry);
      byOffset.set(p.offset, entry);
      byOid.set(entry.oid, entry);
      p.type = -1; // mark resolved
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const p of pending) {
    if (p.type === 6 || p.type === 7) throw new Error('unresolvable delta in pack');
  }
  return entries;
}
// Bytes consumed by one zlib stream starting at buf[0]: inflateSync ignores trailing
// bytes but throws on a truncated stream, so the stream's end is the smallest prefix
// that inflates successfully (binary search).
function inflateConsumed(buf: Buffer): number {
  let lo = 0;
  let hi = buf.length;
  if (hi === 0) return 0;
  try {
    inflateSync(buf);
    // whole buffer is one stream (or a stream plus nothing); binary-search the true end.
  } catch {
    return buf.length;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid === 0) { lo = 1; continue; }
    try {
      inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
  description: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: { id: number; body: string; created_at: string }[];
  seq: number;
  created_at: string;
  updated_at: string;
}
interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
}
interface Repo {
  dbId: number;
  name: string;
  owner: string;
  fullName: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> oid
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
  seq: number;
  created_at: string;
  updated_at: string;
}

const repos = new Map<string, Repo>(); // key `${owner}/${name}`
let seqCounter = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
  repoSeq += 1;
  seqCounter += 1;
  const now = isoOf(seqCounter);
  const repo: Repo = {
    dbId: repoSeq,
    name,
    owner: VIEWER_LOGIN,
    fullName: `${VIEWER_LOGIN}/${name}`,
    isPrivate,
    description,
    defaultBranch: defaultBranch === '' ? 'main' : defaultBranch,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    nextCommentId: 1,
    seq: seqCounter,
    created_at: now,
    updated_at: now,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}
function deleteRepoRecord(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}
function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}
function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}
function refTip(repo: Repo, ref: string): string | undefined {
  // ref may be a branch name, a full ref, or a sha.
  if (SHA_RE.test(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`);
}
function setRef(repo: Repo, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
}
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function peelTag(repo: Repo, oid: string): string | undefined {
  // Peel an annotated tag to its target commit (recursively).
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = repo.objects.get(cur);
    if (!obj) return undefined;
    if (obj.type === 'tag') cur = parseTag(obj.data).object;
    else if (obj.type === 'commit') return cur;
    else return undefined;
  }
  return undefined;
}

// Reachability: walk commits from tips. Returns commit depths (min parent distance)
// and the full object closure. `exclude` commits are treated as already held: their
// own objects are excluded, and (unless they are shallow boundaries) so are their
// ancestors. `depthLimit` caps commit depth: commits at depth == depthLimit are
// reported as new shallow boundaries.
interface ReachResult {
  commits: Map<string, number>;
  objects: Set<string>;
  boundary: string[];
}
function reachable(repo: Repo, tips: string[], opts: { exclude?: Set<string>; shallow?: Set<string>; depthLimit?: number } = {}): ReachResult {
  const exclude = opts.exclude ?? new Set<string>();
  const shallow = opts.shallow ?? new Set<string>();
  // `commits` is every commit reached while walking from the tips (held commits
  // are walked *through*: the client may hold the tip but not its parents).
  // Only commits outside `exclude` are sent.
  const commits = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  for (const tip of tips) {
    const peeled = peelTag(repo, tip);
    const start = peeled ?? tip;
    const obj = repo.objects.get(start);
    if (obj && obj.type === 'commit' && !commits.has(start)) {
      commits.set(start, 0);
      queue.push({ oid: start, depth: 0 });
    }
  }
  // BFS by parent edges; depth = generations from the nearest tip.
  for (let i = 0; i < queue.length; i++) {
    const { oid, depth } = queue[i];
    // Only expand when the parents would still be inside the depth limit
    // (included commits are those with depth < depthLimit).
    if (opts.depthLimit !== undefined && depth + 1 >= opts.depthLimit) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (commits.has(parent)) continue;
      // A shallow boundary's parents are not held, but a commit reached *through*
      // a shallow boundary still counts as new (it is beyond the client's cut).
      commits.set(parent, depth + 1);
      queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  void shallow;
  const objects = new Set<string>();
  const boundary: string[] = [];
  if (opts.depthLimit !== undefined) {
    // The shallow boundary is the deepest *sent* commits (depth N-1): their
    // parents are the cut-off history.
    for (const [oid, depth] of commits) {
      if (depth === opts.depthLimit - 1 && !exclude.has(oid)) boundary.push(oid);
    }
  }
  // Object closure of the *sent* commits, plus tag objects for tag tips.
  const visitTree = (treeOid: string): void => {
    if (objects.has(treeOid)) return;
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    objects.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else objects.add(entry.oid);
    }
  };
  for (const tip of tips) {
    const obj = repo.objects.get(tip);
    if (obj && obj.type === 'tag') objects.add(tip);
  }
  for (const oid of commits.keys()) {
    if (exclude.has(oid)) continue;
    objects.add(oid);
    const commit = repo.objects.get(oid);
    if (commit) visitTree(parseCommit(commit.data).tree);
  }
  return { commits, objects, boundary };
}
function heldClosure(repo: Repo, haves: string[], shallow: Set<string>): Set<string> {
  // Objects the client already holds: closure of the haves, except that traversal
  // stops at shallow-boundary commits (their parents are NOT held).
  const held = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) {
    const peeled = peelTag(repo, have);
    const start = peeled ?? have;
    const obj = repo.objects.get(start);
    if (!obj) continue;
    if (obj.type === 'commit' && !held.has(start)) {
      held.add(start);
      queue.push(start);
    } else if (obj.type === 'tag') {
      held.add(have);
    }
  }
  const visitTree = (treeOid: string): void => {
    if (held.has(treeOid)) return;
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    held.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else held.add(entry.oid);
    }
  };
  for (let i = 0; i < queue.length; i++) {
    const oid = queue[i];
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    visitTree(parseCommit(obj.data).tree);
    if (shallow.has(oid)) continue; // boundary: parents not held
    for (const parent of parseCommit(obj.data).parents) {
      if (!held.has(parent)) {
        held.add(parent);
        queue.push(parent);
      }
    }
  }
  return held;
}
function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>([oid]);
  const queue = [oid];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsB = new Set<string>();
  const queueB = [b];
  ancestorsB.add(b);
  for (let i = 0; i < queueB.length; i++) {
    const obj = repo.objects.get(queueB[i]);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!ancestorsB.has(p)) {
        ancestorsB.add(p);
        queueB.push(p);
      }
    }
  }
  const queueA = [a];
  const seenA = new Set<string>([a]);
  for (let i = 0; i < queueA.length; i++) {
    const cur = queueA[i];
    if (ancestorsB.has(cur)) return cur;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!seenA.has(p)) {
        seenA.add(p);
        queueA.push(p);
      }
    }
  }
  return null;
}

// File maps: path -> blob bytes, derived from a commit's tree.
function treeToFiles(repo: Repo, commitOid: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return files;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob) files.set(path, blob.data);
      }
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return files;
}
function filesToTree(repo: Repo, files: Map<string, Buffer>): string {
  interface Node {
    files: Map<string, Buffer>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!node.dirs.has(seg)) node.dirs.set(seg, make());
      node = node.dirs.get(seg)!;
    }
    node.files.set(segments[segments.length - 1], data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: putObject(repo, 'blob', data) });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
function makeCommit(repo: Repo, files: Map<string, Buffer>, parents: string[], message: string): string {
  const tree = filesToTree(repo, files);
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const data = buildCommit({ tree, parents, message: msg, author: IDENTITY, committer: IDENTITY, timestamp: nextEpoch() });
  return putObject(repo, 'commit', data);
}
function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}
interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}
function diffFiles(oldFiles: Map<string, Buffer>, newFiles: Map<string, Buffer>): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldB = oldFiles.get(path);
    const newB = newFiles.get(path);
    if (oldB !== undefined && newB === undefined) {
      const d = countLines(oldB);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: d, changes: d });
    } else if (oldB === undefined && newB !== undefined) {
      const a = countLines(newB);
      out.push({ filename: path, status: 'added', additions: a, deletions: 0, changes: a });
    } else if (oldB !== undefined && newB !== undefined && !oldB.equals(newB)) {
      const a = countLines(newB);
      const d = countLines(oldB);
      out.push({ filename: path, status: 'modified', additions: Math.max(1, a), deletions: d, changes: Math.max(1, a) + d });
    }
  }
  return out;
}
// Three-way merge check: returns null when clean, else the conflicting paths.
function mergeConflicts(repo: Repo, baseTip: string, headTip: string): string[] | null {
  const base = mergeBase(repo, headTip, baseTip);
  const baseFiles = base === null ? new Map<string, Buffer>() : treeToFiles(repo, base);
  const headFiles = treeToFiles(repo, headTip);
  const curFiles = treeToFiles(repo, baseTip);
  const conflicts: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...curFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const c = curFiles.get(path);
    const headChanged = (b === undefined) !== (h === undefined) || (b !== undefined && h !== undefined && !b.equals(h));
    const curChanged = (b === undefined) !== (c === undefined) || (b !== undefined && c !== undefined && !b.equals(c));
    if (headChanged && curChanged) {
      const same = (h === undefined && c === undefined) || (h !== undefined && c !== undefined && h.equals(c));
      if (!same) conflicts.push(path);
    }
  }
  return conflicts.length === 0 ? null : conflicts;
}
function applySquashMerge(repo: Repo, pr: Pull): { sha: string } | { conflict: string[] } {
  const baseTip = refTip(repo, pr.baseRef);
  const headTip = refTip(repo, pr.headRef);
  if (baseTip === undefined || headTip === undefined) return { conflict: ['missing branch'] };
  const conflicts = mergeConflicts(repo, baseTip, headTip);
  if (conflicts !== null) return { conflict: conflicts };
  const base = mergeBase(repo, headTip, baseTip);
  const baseFiles = base === null ? new Map<string, Buffer>() : treeToFiles(repo, base);
  const headFiles = treeToFiles(repo, headTip);
  const curFiles = treeToFiles(repo, baseTip);
  const merged = new Map(curFiles);
  for (const [path, data] of headFiles) {
    const b = baseFiles.get(path);
    if (b === undefined || !b.equals(data)) merged.set(path, data);
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) merged.delete(path);
  }
  const sha = makeCommit(repo, merged, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
  setRef(repo, `refs/heads/${pr.baseRef}`, sha);
  return { sha };
}
function doMergePull(repo: Repo, pr: Pull): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pr.state !== 'open' || pr.merged) return { ok: false, status: 405, message: 'Pull request is already closed' };
  const res = applySquashMerge(repo, pr);
  if ('conflict' in res) return { ok: false, status: 405, message: `Merge conflict in: ${res.conflict.join(', ')}` };
  pr.state = 'closed';
  pr.merged = true;
  pr.mergeCommitSha = res.sha;
  seqCounter += 1;
  pr.mergedAt = isoOf(seqCounter);
  pr.updated_at = pr.mergedAt;
  return { ok: true, sha: res.sha };
}
function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string; status: number } {
  const headSha = refTip(repo, head);
  const baseSha = refTip(repo, base);
  if (headSha === undefined) return { error: `Head branch ${head} does not exist`, status: 422 };
  if (baseSha === undefined) return { error: `Base branch ${base} does not exist`, status: 422 };
  if (head === base) return { error: 'Head and base are the same', status: 422 };
  const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (existing) return { error: 'A pull request already exists for this head and base', status: 422 };
  seqCounter += 1;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = isoOf(seqCounter);
  const pr: Pull = {
    number,
    id: repo.dbId * 1000000 + number,
    title,
    body: body ?? '',
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    seq: seqCounter,
    created_at: now,
    updated_at: now,
  };
  repo.pulls.push(pr);
  return pr;
}
function createIssueRecord(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  seqCounter += 1;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = isoOf(seqCounter);
  const issue: Issue = {
    id: repo.dbId * 1000000 + number,
    number,
    title,
    body: body ?? '',
    state: 'open',
    labels,
    comments: [],
    seq: seqCounter,
    created_at: now,
    updated_at: now,
  };
  repo.issues.push(issue);
  return issue;
}
function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${VIEWER_LOGIN}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${VIEWER_LOGIN}:${pr.baseRef}` },
    merged: pr.merged,
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    databaseId: repo.dbId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    has_issues: true,
    has_pull_requests: true,
  };
}
function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}
function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MAX_BODY = 64 * 1024 * 1024;
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': reqId(),
    ...extra,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function hostOf(req: IncomingMessage): string {
  return req.headers.host ?? 'localhost';
}
function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1] : null;
}
function authorized(req: IncomingMessage): boolean {
  const tok = bearer(req);
  if (tok === null) return false;
  if (TOKEN === '') return tok !== '';
  return tok === TOKEN;
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}
function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}
function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map(decodeSeg);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function repoFromPath(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return getRepo(owner, name) ?? null;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const query = queryOf(req);
  const segs = splitPath(path.replace(/^\/api\/v3\/?/, ''));
  // Root and meta need no repository.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (!authorized(req)) {
    errJson(res, 401, 'Requires authentication');
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }
  if (method === 'GET' && (path === '/api/v3/user' || path === '/api/v3/user/')) {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return;
  }
  // POST /user/repos
  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
      const input = asRecord(parsed.value);
      const name = str(input.name);
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        errJson(res, 422, 'Invalid repository name');
        return;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        errJson(res, 422, 'Repository already exists');
        return;
      }
      const repo = createRepoRecord(name, input.private === true, str(input.description), str(input.default_branch, 'main'));
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page * perPage < all.length) {
        const url = `http://${hostOf(req)}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        extra.link = `<${url}>; rel="next"`;
      }
      sendJson(res, 200, slice.map(repoJson), extra);
      return;
    }
  }
  // /repos/{owner}/{repo}[...]
  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = segs[1];
    const name = segs[2];
    const repo = repoFromPath(owner, name);
    const rest = segs.slice(3);
    if (repo === null) {
      errJson(res, 404, 'Not Found');
      return;
    }
    await handleRepoRoutes(req, res, body, method, query, repo, rest);
    return;
  }
  errJson(res, 404, 'Not Found');
}

async function handleRepoRoutes(req: IncomingMessage, res: ServerResponse, body: Buffer, method: string, query: URLSearchParams, repo: Repo, rest: string[]): Promise<void> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
      const input = asRecord(parsed.value);
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
      seqCounter += 1;
      repo.updated_at = isoOf(seqCounter);
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepoRecord(repo);
      sendJson(res, 204, null);
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  const head = rest[0];
  // ---- git refs ----
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
      const input = asRecord(parsed.value);
      const ref = str(input.ref);
      const sha = str(input.sha);
      if (!ref.startsWith('refs/') || !SHA_RE.test(sha) || !repo.objects.has(sha)) {
        errJson(res, 422, 'Invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        errJson(res, 422, 'Reference already exists');
        return;
      }
      setRef(repo, ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `${base}/git/refs/${encodeURIComponent(ref)}` });
      return;
    }
    if (method === 'GET') {
      const ref = rest.slice(2).join('/');
      if (ref === '') {
        const all = sortedRefs(repo).map((r) => ({ ref: r.name, object: { sha: r.oid } }));
        sendJson(res, 200, all);
        return;
      }
      const oid = repo.refs.get(ref);
      if (oid === undefined) { errJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { ref, object: { sha: oid, type: 'commit' } });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  // ---- branches ----
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = sortedRefs(repo)
        .filter((r) => r.name.startsWith('refs/heads/'))
        .map((r) => ({ name: r.name.slice('refs/heads/'.length), commit: { sha: r.oid }, protected: false }));
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) { errJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  // ---- commits ----
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = query.get('sha');
      const tip = shaParam !== null ? refTip(repo, shaParam) : headOid(repo);
      const list: Record<string, unknown>[] = [];
      if (tip !== undefined) {
        const seen = new Set<string>();
        const queue = [tip];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const obj = repo.objects.get(cur);
          if (!obj || obj.type !== 'commit') continue;
          const view = parseCommit(obj.data);
          list.push({ sha: cur, commit: { message: view.message.replace(/\n$/, ''), author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } }, parents: view.parents.map((p) => ({ sha: p })) });
          for (const p of view.parents) queue.push(p);
        }
      }
      sendJson(res, 200, list);
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  // ---- contents ----
  if (head === 'contents') {
    await handleContents(req, res, body, method, query, repo, rest.slice(1).join('/'));
    return;
  }
  // ---- labels ----
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
      const input = asRecord(parsed.value);
      const name = str(input.name);
      if (name === '') { errJson(res, 422, 'Label name is required'); return; }
      const existing = repo.labels.get(name);
      if (existing) {
        sendJson(res, 200, { name: existing.name, color: existing.color, description: existing.description });
        return;
      }
      const label: Label = { name, color: str(input.color, 'ededed'), description: str(input.description) };
      repo.labels.set(name, label);
      sendJson(res, 201, { name: label.name, color: label.color, description: label.description });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  // ---- issues ----
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const input = asRecord(parsed.value);
        const title = str(input.title);
        if (title === '') { errJson(res, 422, 'Title is required'); return; }
        const labelNames: string[] = Array.isArray(input.labels)
          ? (input.labels as unknown[]).map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>).name)))
          : [];
        const labels: Label[] = [];
        for (const ln of labelNames) {
          const found = repo.labels.get(ln);
          if (!found) { errJson(res, 422, `Label "${ln}" does not exist`); return; }
          labels.push(found);
        }
        const issue = createIssueRecord(repo, title, str(input.body), labels);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        void sort;
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((i) => issueJson(repo, i)));
        return;
      }
    }
    const num = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(num) && num > 0) {
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (issue === undefined) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
          const input = asRecord(parsed.value);
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          seqCounter += 1;
          issue.updated_at = isoOf(seqCounter);
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        errJson(res, 404, 'Not Found');
        return;
      }
      if (rest[2] === 'comments') {
        if (issue === undefined) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
          const input = asRecord(parsed.value);
          const commentBody = str(input.body);
          if (commentBody === '') { errJson(res, 422, 'Body is required'); return; }
          seqCounter += 1;
          const comment = { id: repo.nextCommentId, body: commentBody, created_at: isoOf(seqCounter) };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.created_at, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })));
          return;
        }
      }
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  // ---- pulls ----
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const input = asRecord(parsed.value);
        const created = createPullRecord(repo, str(input.title), str(input.body), str(input.head), str(input.base));
        if ('error' in created) {
          errJson(res, created.status, created.error);
          return;
        }
        sendJson(res, 201, pullJson(repo, created));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((p) => pullJson(repo, p)));
        return;
      }
    }
    const num = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(num) && num > 0) {
      const pr = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (pr === undefined) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pr));
          return;
        }
        errJson(res, 404, 'Not Found');
        return;
      }
      if (rest[2] === 'files' && method === 'GET') {
        if (pr === undefined) { errJson(res, 404, 'Not Found'); return; }
        const oldFiles = treeToFiles(repo, pr.baseSha);
        const newFiles = treeToFiles(repo, pr.headSha);
        sendJson(res, 200, diffFiles(oldFiles, newFiles));
        return;
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        if (pr === undefined) { errJson(res, 404, 'Not Found'); return; }
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const merged = doMergePull(repo, pr);
        if (!merged.ok) {
          errJson(res, merged.status, merged.message);
          return;
        }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  errJson(res, 404, 'Not Found');
}

async function handleContents(req: IncomingMessage, res: ServerResponse, body: Buffer, method: string, query: URLSearchParams, repo: Repo, filePath: string): Promise<void> {
  const refParam = query.get('ref');
  const tip = refParam !== null ? refTip(repo, refParam) : headOid(repo);
  const filesAtTip = tip === undefined ? new Map<string, Buffer>() : treeToFiles(repo, tip);
  if (method === 'GET') {
    if (tip === undefined && refParam !== null) {
      errJson(res, 404, 'Not Found');
      return;
    }
    if (filePath === '') {
      // root listing
      const names = new Set<string>();
      for (const p of filesAtTip.keys()) names.add(p.split('/')[0]);
      const entries: Record<string, unknown>[] = [];
      for (const name of [...names].sort()) {
        const isDir = [...filesAtTip.keys()].some((p) => p.startsWith(`${name}/`));
        if (isDir) {
          const sub = new Map<string, Buffer>();
          for (const [p, d] of filesAtTip) if (p.startsWith(`${name}/`)) sub.set(p.slice(name.length + 1), d);
          entries.push({ type: 'dir', name, path: name, sha: filesToTree(repo, sub) });
        } else {
          const data = filesAtTip.get(name)!;
          entries.push({ type: 'file', name, path: name, sha: hashObject('blob', data), size: data.length });
        }
      }
      sendJson(res, 200, entries);
      return;
    }
    const data = filesAtTip.get(filePath);
    if (data !== undefined) {
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: b64encode(data),
        sha: hashObject('blob', data),
      });
      return;
    }
    const prefix = `${filePath}/`;
    const children = [...filesAtTip.keys()].filter((p) => p.startsWith(prefix));
    if (children.length === 0) {
      errJson(res, 404, 'Not Found');
      return;
    }
    const names = new Set<string>();
    for (const p of children) names.add(p.slice(prefix.length).split('/')[0]);
    const entries: Record<string, unknown>[] = [];
    for (const name of [...names].sort()) {
      const childPath = `${filePath}/${name}`;
      const isDir = children.some((p) => p.startsWith(`${childPath}/`));
      if (isDir) {
        const sub = new Map<string, Buffer>();
        for (const [p, d] of filesAtTip) if (p.startsWith(`${childPath}/`)) sub.set(p.slice(childPath.length + 1), d);
        entries.push({ type: 'dir', name, path: childPath, sha: filesToTree(repo, sub) });
      } else {
        const d = filesAtTip.get(childPath)!;
        entries.push({ type: 'file', name, path: childPath, sha: hashObject('blob', d), size: d.length });
      }
    }
    sendJson(res, 200, entries);
    return;
  }
  if (method === 'PUT') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
    const input = asRecord(parsed.value);
    const contentB64 = str(input.content);
    const message = str(input.message, 'Update file');
    if (contentB64 === '') { errJson(res, 422, 'Content is required'); return; }
    const data = b64decode(contentB64);
    const branch = str(input.branch, repo.defaultBranch);
    let branchTip = repo.refs.get(`refs/heads/${branch}`);
    if (branchTip === undefined) {
      // Creating a new branch: fork it from the default branch tip (or start empty).
      branchTip = headOid(repo);
      if (branchTip !== undefined) repo.refs.set(`refs/heads/${branch}`, branchTip);
    }
    const files = branchTip === undefined ? new Map<string, Buffer>() : treeToFiles(repo, branchTip);
    const existing = files.get(filePath);
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      const sha = str(input.sha);
      if (sha === '') { errJson(res, 422, 'sha is required to update a file'); return; }
      if (sha.toLowerCase() !== hashObject('blob', existing).toLowerCase()) {
        errJson(res, 409, 'sha does not match the current file');
        return;
      }
    }
    files.set(filePath, data);
    const parents = branchTip === undefined ? [] : [branchTip];
    const commitSha = makeCommit(repo, files, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    const status = isUpdate ? 200 : 201;
    sendJson(res, status, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: hashObject('blob', data), size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
    return;
  }
  if (method === 'DELETE') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
    const input = asRecord(parsed.value);
    const branch = str(input.branch, repo.defaultBranch);
    const branchTip = repo.refs.get(`refs/heads/${branch}`);
    if (branchTip === undefined) { errJson(res, 404, 'Not Found'); return; }
    const files = treeToFiles(repo, branchTip);
    const existing = files.get(filePath);
    if (existing === undefined) { errJson(res, 404, 'Not Found'); return; }
    const sha = str(input.sha);
    if (sha !== '' && sha.toLowerCase() !== hashObject('blob', existing).toLowerCase()) {
      errJson(res, 409, 'sha does not match the current file');
      return;
    }
    files.delete(filePath);
    const commitSha = makeCommit(repo, files, [branchTip], str(input.message, 'Delete file'));
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    sendJson(res, 200, { commit: { sha: commitSha, message: str(input.message, 'Delete file') } });
    return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}
function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`invalid pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}
function pktLinesText(lines: (string | Buffer)[]): Buffer {
  return Buffer.concat(lines.map((l) => (typeof l === 'string' ? pktLine(l) : l)));
}
function v0Caps(repo: Repo): string {
  return `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
}
function v0RefLines(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer[] {
  const caps = service === 'git-receive-pack'
    ? `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
    : v0Caps(repo);
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  let first = true;
  const headLine = `${head ?? ZERO_OID} HEAD${first ? `\0${caps}` : ''}\n`;
  lines.push(pktLine(headLine));
  first = false;
  for (const r of refs) {
    lines.push(pktLine(`${r.oid} ${r.name}${first ? `\0${caps}` : ''}\n`));
    first = false;
    const peeled = peelTag(repo, r.oid);
    if (r.name.startsWith('refs/tags/') && peeled !== undefined && peeled !== r.oid) {
      lines.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  }
  return lines;
}
function gitRepoFromPath(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  const base = name.endsWith('.git') ? name.slice(0, -4) : name;
  return getRepo(owner, base) ?? null;
}

async function handleGit(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (!m) {
    sendRaw(res, 404, Buffer.from('Not Found\n'), 'text/plain; charset=utf-8');
    return;
  }
  const owner = decodeSeg(m[1]);
  const repoName = decodeSeg(m[2]);
  const suffix = m[3];
  const repo = gitRepoFromPath(owner, repoName);
  if (repo === null) {
    sendRaw(res, 404, Buffer.from('Not Found\n'), 'text/plain; charset=utf-8');
    return;
  }
  try {
    if (method === 'GET' && suffix === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendRaw(res, 400, Buffer.from('missing service\n'), 'text/plain; charset=utf-8');
        return;
      }
      const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      if (wantsV2) {
        const lines = [
          pktLine('version 2\n'),
          pktLine(`agent=${AGENT}\n`),
          pktLine('ls-refs=unborn\n'),
          pktLine('fetch=shallow filter\n'),
          pktLine('object-format=sha1\n'),
          PKT_FLUSH,
        ];
        sendRaw(res, 200, Buffer.concat(lines), 'application/x-git-upload-pack-advertisement');
        return;
      }
      const out: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH, ...v0RefLines(repo, service as 'git-upload-pack' | 'git-receive-pack'), PKT_FLUSH];
      sendRaw(res, 200, Buffer.concat(out), `application/x-${service}-advertisement`);
      return;
    }
    if (method === 'POST' && suffix === 'git-upload-pack') {
      await handleUploadPack(req, res, body, repo);
      return;
    }
    if (method === 'POST' && suffix === 'git-receive-pack') {
      await handleReceivePack(req, res, body, repo);
      return;
    }
    sendRaw(res, 404, Buffer.from('Not Found\n'), 'text/plain; charset=utf-8');
  } catch (err) {
    // Never crash the process on a malformed git request; stay healthy.
    try {
      sendRaw(res, 400, Buffer.from(`bad request: ${err instanceof Error ? err.message : String(err)}\n`), 'text/plain; charset=utf-8');
    } catch {
      // response already gone
    }
  }
}

function lsRefsLines(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer[] {
  const out: Buffer[] = [];
  const head = headOid(repo);
  const entries: { oid: string; name: string; symrefTarget?: string; peeled?: string; unborn?: boolean }[] = [];
  if (head !== undefined) {
    entries.push({ oid: head, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else if (args.unborn) {
    entries.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  for (const r of sortedRefs(repo)) {
    const e: { oid: string; name: string; peeled?: string } = { oid: r.oid, name: r.name };
    if (args.peel) {
      const peeled = peelTag(repo, r.oid);
      if (r.name.startsWith('refs/tags/') && peeled !== undefined && peeled !== r.oid) e.peeled = peeled;
    }
    entries.push(e);
  }
  for (const e of entries) {
    if (args.prefixes.length > 0 && !args.prefixes.some((p) => e.name.startsWith(p))) continue;
    if (e.unborn) {
      out.push(pktLine(`unborn ${e.name} symref-target:${e.symrefTarget}\n`));
      continue;
    }
    let line = `${e.oid} ${e.name}`;
    if (args.symrefs && e.symrefTarget) line += ` symref-target:${e.symrefTarget}`;
    if (e.peeled) line += ` peeled:${e.peeled}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return out;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}
function parseFetchArgs(pkts: Pkt[], v2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  let inArgs = !v2; // v0 has no command/delim preamble
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') {
      if (pkt.kind === 'delim') inArgs = true;
      continue;
    }
    const line = pkt.payload.toString('utf8');
    if (!inArgs) {
      // v2 command section: command=fetch / agent= / object-format=
      continue;
    }
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isInteger(n)) args.depth = n;
    } else if (text.startsWith('filter ')) args.filter = text.slice(7);
    else if (text === 'done' || text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta') continue;
    else if (text.startsWith('deepen-since ') || text.startsWith('deepen-not ')) continue;
  }
  return args;
}

function sidebandPack(pack: Buffer): Buffer[] {
  // Split pack bytes into sideband band-1 pkt-lines (<= 65516 bytes of payload each).
  const out: Buffer[] = [];
  const CHUNK = 60000;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pktLine(payload));
  }
  if (pack.length === 0) {
    // no band-1 packets at all
  }
  return out;
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, body: Buffer, repo: Repo): Promise<void> {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const pkts = decodePkts(body);
  const firstData = pkts.find((p) => p.kind === 'data');
  const firstLine = firstData ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';
  if (isV2 && firstLine.startsWith('command=ls-refs')) {
    let inArgs = false;
    const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const pkt of pkts) {
      if (pkt.kind === 'delim') { inArgs = true; continue; }
      if (pkt.kind === 'flush') break;
      if (pkt.kind !== 'data' || !inArgs) continue;
      const text = pkt.payload.toString('utf8').replace(/\n$/, '');
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    sendRaw(res, 200, Buffer.concat(lsRefsLines(repo, args)), 'application/x-git-upload-pack-result');
    return;
  }
  // fetch (v2 command=fetch or v0 want lines)
  const args = parseFetchArgs(pkts, isV2);
  const wantSet = [...new Set(args.wants)].filter((w) => SHA_RE.test(w) && repo.objects.has(w));
  const shallowSet = new Set(args.shallow);
  const held = heldClosure(repo, args.haves, shallowSet);
  let sendObjects: Set<string>;
  let newShallow: string[] = [];
  let unshallow: string[] = [];
  if (wantSet.length === 0) {
    sendObjects = new Set();
  } else {
    const reach = reachable(repo, wantSet, { exclude: held, depthLimit: args.depth ?? undefined });
    sendObjects = new Set([...reach.objects].filter((o) => !held.has(o)));
    if (args.depth !== null) {
      newShallow = reach.boundary;
      for (const s of args.shallow) {
        if (reach.commits.has(s)) unshallow.push(s);
      }
    }
  }
  const pack = sendObjects.size === 0
    ? null
    : writePack([...sendObjects].map((oid) => {
        const obj = repo.objects.get(oid)!;
        return { type: obj.type, data: obj.data };
      }));
  const chunks: Buffer[] = [];
  if (isV2) {
    chunks.push(pktLine('acknowledgments\n'));
    if (args.haves.length > 0) {
      for (const h of args.haves) if (repo.objects.has(h)) chunks.push(pktLine(`ACK ${h}\n`));
      chunks.push(pktLine('ready\n'));
    } else {
      chunks.push(pktLine('NAK\n'));
    }
    chunks.push(PKT_DELIM);
    if (newShallow.length > 0 || unshallow.length > 0) {
      chunks.push(pktLine('shallow-info\n'));
      for (const s of newShallow) chunks.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
      chunks.push(PKT_DELIM);
    }
    chunks.push(pktLine('packfile\n'));
    if (pack !== null) chunks.push(...sidebandPack(pack));
    chunks.push(PKT_FLUSH);
  } else {
    if (args.haves.length > 0) {
      for (const h of args.haves) if (repo.objects.has(h)) chunks.push(pktLine(`ACK ${h}\n`));
    } else {
      chunks.push(pktLine('NAK\n'));
    }
    for (const s of newShallow) chunks.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
    if (pack !== null) chunks.push(...sidebandPack(pack));
    chunks.push(PKT_FLUSH);
  }
  sendRaw(res, 200, Buffer.concat(chunks), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(_req: IncomingMessage, res: ServerResponse, body: Buffer, repo: Repo): Promise<void> {
  // Commands are pkt-lines up to the first flush; everything after it is the pack.
  // Decode only the command prefix — the pack bytes are not pkt-lines.
  const pkts: Pkt[] = [];
  let packStart = body.length;
  {
    let off = 0;
    while (off + 4 <= body.length) {
      const lenText = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`invalid pkt-line length ${JSON.stringify(lenText)}`);
      const len = parseInt(lenText, 16);
      if (len === 0) {
        packStart = off + 4;
        break;
      }
      if (len === 1) {
        pkts.push({ kind: 'delim', payload: Buffer.alloc(0) });
        off += 4;
        continue;
      }
      if (len < 4 || off + len > body.length) throw new Error('truncated pkt-line');
      pkts.push({ kind: 'data', payload: body.subarray(off + 4, off + len) });
      off += len;
    }
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
    caps: string[];
  }
  const commands: Command[] = [];
  let negotiatedSideband = false;
  let negotiatedReport = false;
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    const text = pkt.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const caps = nul >= 0 ? text.slice(nul + 1).trim().split(/\s+/).filter(Boolean) : [];
    const parts = head.trim().split(/\s+/);
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2], caps });
    if (caps.includes('side-band-64k')) negotiatedSideband = true;
    if (caps.includes('report-status') || caps.includes('report-status-v2')) negotiatedReport = true;
  }
  const packBytes = body.subarray(packStart);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const received: PackEntry[] = [];
  if (hasUpdates) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error: empty pack';
    } else {
      try {
        const entries = readPack(packBytes);
        for (const e of entries) received.push(e);
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  // Verify the pack's trailer checksum.
  if (unpackOk && hasUpdates && packBytes.length >= 20) {
    const trailer = packBytes.subarray(packBytes.length - 20).toString('hex');
    const actual = sha1(packBytes.subarray(0, packBytes.length - 20));
    if (trailer !== actual) {
      unpackOk = false;
      unpackDetail = 'unpacker error: pack checksum mismatch';
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) {
    for (const e of received) putObject(repo, e.type, e.data);
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} remote ref does not exist`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      reportLines.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} already exists`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${cmd.ref} remote ref does not exist`);
      continue;
    }
    if (current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    const newTip = peelTag(repo, cmd.newOid) ?? cmd.newOid;
    if (!isAncestor(repo, cmd.oldOid, newTip)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }
  const fullReport = Buffer.concat([
    pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`),
    ...reportLines.map((l) => pktLine(`${l}\n`)),
  ]);
  void negotiatedReport;
  const out: Buffer[] = [];
  if (negotiatedSideband) {
    const CHUNK = 60000;
    for (let off = 0; off < fullReport.length; off += CHUNK) {
      const slice = fullReport.subarray(off, Math.min(fullReport.length, off + CHUNK));
      out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  } else {
    out.push(fullReport);
  }
  out.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// GraphQL v4 (a small parser + executor for the documents gh / github-mcp-server send)
// ---------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue };
interface GqlSelection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  args?: Record<string, GqlValue>;
  selections?: GqlSelection[];
  typeCondition?: string;
}
interface GqlOperation {
  type: 'query' | 'mutation';
  name?: string;
  selections: GqlSelection[];
}
interface GqlDocument {
  operations: GqlOperation[];
  fragments: Record<string, { type: string; selections: GqlSelection[] }>;
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!=$@=&|'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}
class GqlParser {
  private tokens: string[];
  private pos = 0;
  constructor(src: string) {
    this.tokens = gqlTokenize(src);
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }
  expect(t: string): void {
    if (this.next() !== t) throw new Error(`expected ${t}`);
  }
  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: {} };
    while (this.pos < this.tokens.length) {
      const tok = this.next();
      if (tok === 'query' || tok === 'mutation') {
        let name: string | undefined;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        this.skipVarDefs();
        const selections = this.parseSelectionSet();
        doc.operations.push({ type: tok as 'query' | 'mutation', name, selections });
      } else if (tok === 'fragment') {
        const fragName = this.next();
        this.expect('on');
        const type = this.next();
        const selections = this.parseSelectionSet();
        doc.fragments[fragName] = { type, selections };
      } else if (tok === '{') {
        this.pos -= 1;
        const selections = this.parseSelectionSet();
        doc.operations.push({ type: 'query', selections });
      } else {
        throw new Error(`unexpected token ${tok}`);
      }
    }
    return doc;
  }
  skipVarDefs(): void {
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const t = this.next();
        if (t === '(') depth += 1;
        else if (t === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }
  parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const type = this.next();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition: type, selections };
      }
      const fragName = this.next();
      return { kind: 'fragment', name: fragName };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    let args: Record<string, GqlValue> | undefined;
    if (this.peek() === '(') args = this.parseArguments();
    // directives (@...) — skip
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArguments();
    }
    let selections: GqlSelection[] | undefined;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }
  parseArguments(): Record<string, GqlValue> {
    this.expect('(');
    const args: Record<string, GqlValue> = {};
    while (this.peek() !== ')' && this.peek() !== undefined) {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseValue(): GqlValue {
    const tok = this.next();
    if (tok === '$') return { $var: this.next() } as unknown as GqlValue;
    if (tok === '[') {
      const arr: GqlValue[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (tok === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const name = this.next();
        this.expect(':');
        obj[name] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok.startsWith('"')) return JSON.parse(tok) as string;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^-?[0-9]+$/.test(tok)) return Number(tok);
    if (/^-?[0-9]*\.[0-9]+$/.test(tok)) return Number(tok);
    return tok; // enum
  }
}
function resolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    if ('$var' in rec) return vars[String(rec.$var)] ?? null;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) out[k] = resolveValue(val as GqlValue, vars);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, vars));
  return v;
}
function resolveArgs(sel: GqlSelection, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (sel.args) for (const [k, v] of Object.entries(sel.args)) out[k] = resolveValue(v, vars);
  return out;
}

type GqlNode = Record<string, unknown> & { __type: string };
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'resourcePath', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url', 'resourcePath'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'primaryLanguage'],
  SearchType: [],
  User: ['login', 'id', 'name', 'email'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI', 'PACKAGE', 'MARKETPLACE'];

function findRepoByDbId(dbId: number): Repo | undefined {
  for (const r of repos.values()) if (r.dbId === dbId) return r;
  return undefined;
}
function repoNode(repo: Repo): GqlNode {
  return { __type: 'Repository', __repo: repo };
}
function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __type: 'Issue', __repo: repo, __issue: issue };
}
function pullNode(repo: Repo, pr: Pull): GqlNode {
  return { __type: 'PullRequest', __repo: repo, __pr: pr };
}
function prState(pr: Pull): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}
function prMergeable(repo: Repo, pr: Pull): string {
  if (pr.state !== 'open') return 'UNKNOWN';
  const baseTip = refTip(repo, pr.baseRef);
  const headTip = refTip(repo, pr.headRef);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  return mergeConflicts(repo, baseTip, headTip) === null ? 'MERGEABLE' : 'CONFLICTING';
}

function resolveField(node: GqlNode, field: string, args: Record<string, unknown>): unknown {
  const type = node.__type;
  if (type === 'CommentEdge') {
    if (field === 'node') {
      const comment = node.__comment as { id: number; body: string };
      const repo = node.__repo as Repo;
      const issue = node.__issue as Issue;
      return { __type: 'IssueComment', __comment: comment, __repo: repo, __issue: issue } as GqlNode;
    }
    return undefined;
  }
  if (type === 'IssueComment') {
    const comment = node.__comment as { id: number; body: string };
    const repo = node.__repo as Repo;
    const issue = node.__issue as Issue;
    if (field === 'id') return globalId('IssueComment', repo.dbId, issue.number, comment.id);
    if (field === 'body') return comment.body;
    return undefined;
  }
  if (type === 'Query') {
    if (field === 'viewer') return { __type: 'User', __login: VIEWER_LOGIN } as GqlNode;
    if (field === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = getRepo(owner, name);
      return repo === undefined ? null : repoNode(repo);
    }
    if (field === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoByDbId(Number(parsed.parts[0]));
        return repo === undefined ? null : repoNode(repo);
      }
      if (parsed.kind === 'Issue') {
        const repo = findRepoByDbId(Number(parsed.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
        return issue === undefined || repo === undefined ? null : issueNode(repo, issue);
      }
      if (parsed.kind === 'PullRequest') {
        const repo = findRepoByDbId(Number(parsed.parts[0]));
        const pr = repo?.pulls.find((p) => p.number === Number(parsed.parts[1]));
        return pr === undefined || repo === undefined ? null : pullNode(repo, pr);
      }
      return null;
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] === undefined && name !== 'SearchType') return null;
      return { __type: '__Type', __name: name } as GqlNode;
    }
    return undefined;
  }
  if (type === '__Type') {
    const name = String(node.__name ?? '');
    if (field === 'fields') {
      return (TYPE_FIELDS[name] ?? []).map((n) => ({ __type: '__Field', __name: n }) as GqlNode);
    }
    if (field === 'enumValues') {
      if (name !== 'SearchType') return [];
      return SEARCH_ENUMS.map((n) => ({ __type: '__EnumValue', __name: n }) as GqlNode);
    }
    if (field === 'name') return name;
    return undefined;
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (field === 'name') return String(node.__name ?? '');
    return undefined;
  }
  if (type === 'User') {
    if (field === 'login') return String(node.__login ?? VIEWER_LOGIN);
    if (field === 'id') return globalId('User', VIEWER_ID);
    if (field === 'name') return VIEWER_NAME;
    return undefined;
  }
  if (type === 'Repository') {
    const repo = node.__repo as Repo;
    switch (field) {
      case 'id': return globalId('Repository', repo.dbId);
      case 'databaseId': return repo.dbId;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'owner': return { __type: 'User', __login: repo.owner } as GqlNode;
      case 'defaultBranchRef': return { __type: 'Ref', __name: repo.defaultBranch } as GqlNode;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'url': return `https://example.invalid/${repo.fullName}`;
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue === undefined ? null : issueNode(repo, issue);
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s)));
          list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const orderBy = args.orderBy as Record<string, unknown> | undefined;
        if (orderBy && String(orderBy.field ?? '') === 'CREATED_AT') {
          list.sort((a, b) => (String(orderBy.direction ?? 'DESC') === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        } else {
          list.sort((a, b) => a.seq - b.seq);
        }
        const after = args.after;
        if (typeof after === 'string' && after !== '') {
          try {
            const decoded = Buffer.from(after, 'base64').toString('utf8');
            const m = /^cursor:(\d+)$/.exec(decoded);
            if (m) {
              const n = Number(m[1]);
              list = list.filter((i) => i.number > n);
            }
          } catch {
            // ignore a bad cursor
          }
        }
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, first);
        const hasNext = list.length > first;
        const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1].number}`, 'utf8').toString('base64') : null;
        return { __type: 'IssueConnection', __nodes: page.map((i) => issueNode(repo, i)), __hasNextPage: hasNext, __endCursor: endCursor } as GqlNode;
      }
      case 'pullRequests': {
        let list = repo.pulls.filter((p) => p.state === 'open');
        const first = typeof args.first === 'number' ? args.first : list.length;
        list = list.slice(0, first);
        return { __type: 'PullRequestConnection', __nodes: list.map((p) => pullNode(repo, p)) } as GqlNode;
      }
      case 'pullRequest': {
        const pr = repo.pulls.find((p) => p.number === Number(args.number));
        return pr === undefined ? null : pullNode(repo, pr);
      }
      default: return undefined;
    }
  }
  if (type === 'Issue') {
    const issue = node.__issue as Issue;
    const repo = node.__repo as Repo;
    switch (field) {
      case 'id': return globalId('Issue', repo.dbId, issue.number);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return issue.body;
      case 'createdAt': return issue.created_at;
      case 'updatedAt': return issue.updated_at;
      case 'repository': return repoNode(repo);
      default: return undefined;
    }
  }
  if (type === 'PullRequest') {
    const pr = node.__pr as Pull;
    const repo = node.__repo as Repo;
    switch (field) {
      case 'id': return globalId('PullRequest', repo.dbId, pr.number);
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return prState(pr);
      case 'merged': return pr.merged;
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'mergeable': return prMergeable(repo, pr);
      case 'mergedAt': return pr.mergedAt;
      case 'createdAt': return pr.created_at;
      case 'files': {
        const oldFiles = treeToFiles(repo, pr.baseSha);
        const newFiles = treeToFiles(repo, pr.headSha);
        const changes = diffFiles(oldFiles, newFiles);
        const first = typeof args.first === 'number' ? args.first : changes.length;
        return { __type: 'PullRequestFileConnection', __nodes: changes.slice(0, first).map((c) => ({ __type: 'PullRequestChangedFile', __path: c.filename }) as GqlNode) } as GqlNode;
      }
      default: return undefined;
    }
  }
  if (type === 'IssueConnection') {
    if (field === 'nodes') return node.__nodes as GqlNode[];
    if (field === 'pageInfo') {
      return { __type: 'PageInfo', __hasNextPage: node.__hasNextPage, __endCursor: node.__endCursor } as GqlNode;
    }
    if (field === 'totalCount') return (node.__nodes as GqlNode[]).length;
    return undefined;
  }
  if (type === 'PullRequestConnection') {
    if (field === 'nodes') return node.__nodes as GqlNode[];
    if (field === 'totalCount') return (node.__nodes as GqlNode[]).length;
    return undefined;
  }
  if (type === 'PullRequestFileConnection') {
    if (field === 'nodes') return node.__nodes as GqlNode[];
    return undefined;
  }
  if (type === 'PullRequestChangedFile') {
    if (field === 'path') return String(node.__path ?? '');
    return undefined;
  }
  if (type === 'PageInfo') {
    if (field === 'hasNextPage') return node.__hasNextPage === true;
    if (field === 'endCursor') return (node.__endCursor as string | null) ?? null;
    return undefined;
  }
  if (type === 'Ref') {
    if (field === 'name') return String(node.__name ?? '');
    return undefined;
  }
  return undefined;
}

function executeSelections(node: GqlNode, sels: GqlSelection[], vars: Record<string, unknown>, errors: { message: string }[], doc: GqlDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.name !== undefined) {
        const frag = doc.fragments[sel.name];
        if (frag) {
          if (frag.type === node.__type || frag.type === 'Node') {
            Object.assign(out, executeSelections(node, frag.selections, vars, errors, doc));
          }
        }
        continue;
      }
      if (sel.typeCondition === undefined || sel.typeCondition === node.__type) {
        Object.assign(out, executeSelections(node, sel.selections ?? [], vars, errors, doc));
      }
      continue;
    }
    const fieldName = sel.name ?? '';
    const key = sel.alias ?? fieldName;
    const args = resolveArgs(sel, vars);
    const value = resolveField(node, fieldName, args);
    if (value === undefined) {
      errors.push({ message: `Cannot query field "${fieldName}" on type "${node.__type}".` });
      out[key] = null;
      continue;
    }
    out[key] = executeValue(value, sel.selections, vars, errors, doc);
  }
  return out;
}
function executeValue(value: unknown, sels: GqlSelection[] | undefined, vars: Record<string, unknown>, errors: { message: string }[], doc: GqlDocument): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => executeValue(v, sels, vars, errors, doc));
  if (typeof value === 'object' && (value as GqlNode).__type !== undefined) {
    if (!sels || sels.length === 0) return {};
    return executeSelections(value as GqlNode, sels, vars, errors, doc);
  }
  return value;
}
function executeMutation(op: GqlOperation, vars: Record<string, unknown>, errors: { message: string }[], doc: GqlDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind !== 'field') continue;
    const fieldName = sel.name ?? '';
    const key = sel.alias ?? fieldName;
    const args = resolveArgs(sel, vars);
    const input = (args.input ?? {}) as Record<string, unknown>;
    let payload: GqlNode | null = null;
    if (fieldName === 'createIssue') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
      if (repo === undefined) {
        errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        out[key] = null;
        continue;
      }
      const issue = createIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      payload = { __type: 'CreateIssuePayload', __issueNode: issueNode(repo, issue) } as GqlNode;
    } else if (fieldName === 'closeIssue') {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      const repo = parsed?.kind === 'Issue' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
      const issue = repo?.issues.find((i) => i.number === Number(parsed?.parts[1]));
      if (repo === undefined || issue === undefined) {
        errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        out[key] = null;
        continue;
      }
      issue.state = 'closed';
      seqCounter += 1;
      issue.updated_at = isoOf(seqCounter);
      payload = { __type: 'CloseIssuePayload', __issueNode: issueNode(repo, issue) } as GqlNode;
    } else if (fieldName === 'createPullRequest') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
      if (repo === undefined) {
        errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        out[key] = null;
        continue;
      }
      const created = createPullRecord(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in created) {
        errors.push({ message: created.error });
        out[key] = null;
        continue;
      }
      payload = { __type: 'CreatePullRequestPayload', __prNode: pullNode(repo, created) } as GqlNode;
    } else if (fieldName === 'mergePullRequest') {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parsed?.kind === 'PullRequest' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
      const pr = repo?.pulls.find((p) => p.number === Number(parsed?.parts[1]));
      if (repo === undefined || pr === undefined) {
        errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
        out[key] = null;
        continue;
      }
      const merged = doMergePull(repo, pr);
      if (!merged.ok) {
        errors.push({ message: merged.message });
        out[key] = null;
        continue;
      }
      payload = { __type: 'MergePullRequestPayload', __prNode: pullNode(repo, pr) } as GqlNode;
    } else if (fieldName === 'addComment') {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      const repo = parsed?.kind === 'Issue' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
      const issue = repo?.issues.find((i) => i.number === Number(parsed?.parts[1]));
      if (repo === undefined || issue === undefined) {
        errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        out[key] = null;
        continue;
      }
      seqCounter += 1;
      const comment = { id: repo.nextCommentId, body: String(input.body ?? ''), created_at: isoOf(seqCounter) };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      payload = { __type: 'AddCommentPayload', __comment: comment, __repo: repo, __issue: issue } as GqlNode;
    } else {
      errors.push({ message: `Cannot query field "${fieldName}" on type "Mutation".` });
      out[key] = null;
      continue;
    }
    out[key] = executePayload(payload, sel.selections ?? [], vars, errors, doc);
  }
  return out;
}
function executePayload(payload: GqlNode, sels: GqlSelection[], vars: Record<string, unknown>, errors: { message: string }[], doc: GqlDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind !== 'field') continue;
    const fieldName = sel.name ?? '';
    const key = sel.alias ?? fieldName;
    if (payload.__type === 'CreateIssuePayload' || payload.__type === 'CloseIssuePayload') {
      if (fieldName === 'issue') {
        const node = payload.__issueNode as GqlNode;
        out[key] = node === undefined ? null : executeSelections(node, sel.selections ?? [], vars, errors, doc);
        continue;
      }
    }
    if (payload.__type === 'CreatePullRequestPayload' || payload.__type === 'MergePullRequestPayload') {
      if (fieldName === 'pullRequest') {
        const node = payload.__prNode as GqlNode;
        out[key] = node === undefined ? null : executeSelections(node, sel.selections ?? [], vars, errors, doc);
        continue;
      }
    }
    if (payload.__type === 'AddCommentPayload') {
      if (fieldName === 'commentEdge') {
        const comment = payload.__comment as { id: number; body: string };
        const repo = payload.__repo as Repo;
        const issue = payload.__issue as Issue;
        const edgeNode = { __type: 'CommentEdge', __comment: comment, __repo: repo, __issue: issue } as GqlNode;
        out[key] = executeSelections(edgeNode, sel.selections ?? [], vars, errors, doc);
        continue;
      }
    }
    errors.push({ message: `Cannot query field "${fieldName}" on type "${payload.__type}".` });
    out[key] = null;
  }
  return out;
}
function executeGraphQLRequest(body: unknown): { status: number; json: unknown } {
  const runOne = (req: unknown): Record<string, unknown> => {
    const rec = asRecord(req);
    const queryText = String(rec.query ?? '');
    const vars = asRecord(rec.variables);
    const operationName = typeof rec.operationName === 'string' ? rec.operationName : undefined;
    let doc: GqlDocument;
    try {
      doc = new GqlParser(queryText).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    const errors: { message: string }[] = [];
    let op = doc.operations[0];
    if (operationName !== undefined) {
      op = doc.operations.find((o) => o.name === operationName) ?? op;
    }
    if (op === undefined) return { errors: [{ message: 'No operation in document' }] };
    if (op.type === 'mutation') {
      const data = executeMutation(op, vars as Record<string, unknown>, errors, doc);
      return errors.length > 0 ? { data, errors } : { data };
    }
    const data = executeSelections({ __type: 'Query' } as GqlNode, op.selections, vars as Record<string, unknown>, errors, doc);
    return errors.length > 0 ? { data, errors } : { data };
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map(runOne) };
  }
  return { status: 200, json: runOne(body) };
}

// (CommentEdge / IssueComment are resolved at the top of resolveField above.)

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0, Streamable HTTP, revision 2026-07-28)
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}
const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by owner, repository and number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' } }, required: ['owner', 'repo', 'issue_number'] },
  },
];
function mcpRepoOf(args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
  let name = '';
  if (typeof args.repo === 'string') name = args.repo;
  else if (typeof args.repository === 'string') name = args.repository;
  if (typeof args.full_name === 'string' && name === '') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = parts[0];
      name = parts[1];
    }
  }
  if (name === '') return null;
  return repoFromPath(owner, name);
}
function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}
function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
function callMcpTool(name: string, args: Record<string, unknown>): { ok: true; result: Record<string, unknown> } | { ok: false; error: string } {
  const missing = (tool: McpToolDef): string | null => {
    for (const req of tool.inputSchema.required) {
      if (args[req] === undefined || args[req] === null || args[req] === '') return req;
    }
    return null;
  };
  if (name === 'create_repo') {
    const tool = MCP_TOOLS[0];
    const miss = missing(tool);
    if (miss) return { ok: true, result: toolErrorResult(`missing required argument: ${miss}`) };
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return { ok: true, result: toolErrorResult('invalid repository name') };
    if (getRepo(VIEWER_LOGIN, repoName)) return { ok: true, result: toolErrorResult('Repository already exists') };
    const repo = createRepoRecord(repoName, args.private === true, typeof args.description === 'string' ? args.description : '', 'main');
    return { ok: true, result: toolResult(repoJson(repo)) };
  }
  if (name === 'get_repo') {
    const tool = MCP_TOOLS[1];
    const miss = missing(tool);
    if (miss) return { ok: true, result: toolErrorResult(`missing required argument: ${miss}`) };
    const repo = mcpRepoOf(args);
    if (repo === null) return { ok: true, result: toolErrorResult('Repository not found') };
    return { ok: true, result: toolResult(repoJson(repo)) };
  }
  if (name === 'create_issue') {
    const tool = MCP_TOOLS[2];
    const miss = missing(tool);
    if (miss) return { ok: true, result: toolErrorResult(`missing required argument: ${miss}`) };
    const repo = mcpRepoOf(args);
    if (repo === null) return { ok: true, result: toolErrorResult('Repository not found') };
    const issue = createIssueRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return { ok: true, result: toolResult(issueJson(repo, issue)) };
  }
  if (name === 'list_issues') {
    const tool = MCP_TOOLS[3];
    const miss = missing(tool);
    if (miss) return { ok: true, result: toolErrorResult(`missing required argument: ${miss}`) };
    const repo = mcpRepoOf(args);
    if (repo === null) return { ok: true, result: toolErrorResult('Repository not found') };
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.seq - a.seq);
    const arr = list.map((i) => issueJson(repo, i));
    return { ok: true, result: toolResult(arr) };
  }
  if (name === 'create_pull_request') {
    const tool = MCP_TOOLS[4];
    const miss = missing(tool);
    if (miss) return { ok: true, result: toolErrorResult(`missing required argument: ${miss}`) };
    const repo = mcpRepoOf(args);
    if (repo === null) return { ok: true, result: toolErrorResult('Repository not found') };
    const created = createPullRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
    if ('error' in created) return { ok: true, result: toolErrorResult(created.error) };
    return { ok: true, result: toolResult(pullJson(repo, created)) };
  }
  if (name === 'merge_pull_request') {
    const tool = MCP_TOOLS[5];
    const miss = missing(tool);
    if (miss) return { ok: true, result: toolErrorResult(`missing required argument: ${miss}`) };
    const repo = mcpRepoOf(args);
    if (repo === null) return { ok: true, result: toolErrorResult('Repository not found') };
    const num = Number(args.pull_number);
    const pr = repo.pulls.find((p) => p.number === num);
    if (pr === undefined) return { ok: true, result: toolErrorResult('Pull request not found') };
    const merged = doMergePull(repo, pr);
    if (!merged.ok) return { ok: true, result: toolErrorResult(merged.message) };
    return { ok: true, result: toolResult({ sha: merged.sha, merged: true, number: pr.number, message: 'Pull request successfully merged' }) };
  }
  if (name === 'list_repos') {
    const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
    return { ok: true, result: toolResult(all.map(repoJson)) };
  }
  if (name === 'get_issue') {
    const tool = MCP_TOOLS[7];
    const miss = missing(tool);
    if (miss) return { ok: true, result: toolErrorResult(`missing required argument: ${miss}`) };
    const repo = mcpRepoOf(args);
    if (repo === null) return { ok: true, result: toolErrorResult('Repository not found') };
    const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
    if (issue === undefined) return { ok: true, result: toolErrorResult('Issue not found') };
    return { ok: true, result: toolResult(issueJson(repo, issue)) };
  }
  return { ok: false, error: `Unknown tool: ${name}` };
}

function mcpRpc(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function sendMcp(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    res.writeHead(200, { 'content-length': '0' });
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendMcp(res, 405, mcpRpcError(null, -32600, 'Method not allowed'));
    return;
  }
  const text = body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    sendMcp(res, 400, mcpRpcError(null, -32700, 'Parse error'));
    return;
  }
  const rec = asRecord(parsed);
  const id = rec.id ?? null;
  if (!authorized(req)) {
    sendMcp(res, 401, mcpRpcError(id, -32001, 'Unauthorized'));
    return;
  }
  const rpcMethod = typeof rec.method === 'string' ? rec.method : '';
  const params = asRecord(rec.params);
  if (rpcMethod === 'server/discover') {
    sendMcp(res, 200, mcpRpc(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
    }));
    return;
  }
  if (rpcMethod === 'initialize') {
    sendMcp(res, 200, mcpRpc(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    }));
    return;
  }
  if (rpcMethod === 'ping') {
    sendMcp(res, 200, mcpRpc(id, {}));
    return;
  }
  if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return;
  }
  if (rpcMethod === 'tools/list') {
    sendMcp(res, 200, mcpRpc(id, { tools: MCP_TOOLS }));
    return;
  }
  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = asRecord(params.arguments);
    const known = MCP_TOOLS.find((t) => t.name === toolName);
    if (known === undefined) {
      sendMcp(res, 200, mcpRpcError(id, -32602, `Unknown tool: ${toolName}`));
      return;
    }
    const outcome = callMcpTool(toolName, args);
    if (!outcome.ok) {
      sendMcp(res, 200, mcpRpcError(id, -32602, outcome.error));
      return;
    }
    sendMcp(res, 200, mcpRpc(id, outcome.result));
    return;
  }
  sendMcp(res, 200, mcpRpcError(id, -32601, `Method not found: ${rpcMethod}`));
}

// ---------------------------------------------------------------------------
// Router + lifecycle
// ---------------------------------------------------------------------------

function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res, body);
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            errJson(res, 404, 'Not Found');
            return;
          }
          if (!authorized(req)) {
            errJson(res, 401, 'Requires authentication');
            return;
          }
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const out = executeGraphQLRequest(parsed.value);
          sendJson(res, out.status, out.json);
          return;
        }
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, body);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          await handleGit(req, res, body);
          return;
        }
        errJson(res, 404, 'Not Found');
      } catch (err) {
        try {
          errJson(res, 500, err instanceof Error ? err.message : 'Internal error');
        } catch {
          // response already gone
        }
      }
    })();
  });
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // not done yet
    }
    await sleep(retryDelay(attempt));
  }
}
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  if (ENV_URL === '') {
    // No env (local manual testing): just serve on the ephemeral port, forever.
    process.stdout.write('[entry] MAKEFUN_ENV_URL is not set: serving standalone\n');
    await new Promise<void>(() => undefined);
    return;
  }
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
