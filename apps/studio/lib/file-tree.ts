/** 코드 탭의 "모든 파일" 목록을 접고 펼 수 있는 폴더 트리로 보여 줄 때 쓰는 순수 함수들. 서버에서 받은 평평한 경로 목록만 다루고, 그리기는 컴포넌트가 한다 */

export interface FileTreeFolder {
  type: 'folder';
  /** 폴더 이름만 (경로 아님) */
  name: string;
  /** 루트부터의 전체 경로 */
  path: string;
  children: FileTreeNode[];
}

export interface FileTreeFile {
  type: 'file';
  name: string;
  path: string;
}

export type FileTreeNode = FileTreeFolder | FileTreeFile;

interface MutableFolder {
  name: string;
  path: string;
  children: Map<string, MutableFile | MutableFolder>;
}

interface MutableFile {
  name: string;
  path: string;
}

function isFolder(node: MutableFile | MutableFolder): node is MutableFolder {
  return 'children' in node;
}

/** 평평한 경로 목록에서 폴더 트리를 만든다. 순서는 상관없고, 같은 경로가 여러 번 나와도 한 번만 담는다 */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root = new Map<string, MutableFile | MutableFolder>();

  for (const raw of paths) {
    const parts = raw.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let children = root;
    let currentPath = '';
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const isLast = index === parts.length - 1;
      const existing = children.get(name);

      if (isLast) {
        // 파일 경로가 다른 파일의 부모로도 쓰이는 이상한 입력이면 이미 있는 폴더를 그대로 둔다
        if (!existing) children.set(name, { name, path: currentPath });
        continue;
      }

      if (existing && isFolder(existing)) {
        children = existing.children;
        continue;
      }

      // 아직 없거나(또는 같은 이름의 파일 항목뿐이면) 폴더로 만든다
      const folder: MutableFolder = { name, path: currentPath, children: new Map() };
      children.set(name, folder);
      children = folder.children;
    }
  }

  return sortedNodes(root);
}

function sortedNodes(children: Map<string, MutableFile | MutableFolder>): FileTreeNode[] {
  const nodes: FileTreeNode[] = [...children.values()].map((node) =>
    isFolder(node) ? { type: 'folder', name: node.name, path: node.path, children: sortedNodes(node.children) } : { type: 'file', name: node.name, path: node.path },
  );
  return nodes.sort(compareNodes);
}

/** 폴더가 파일보다 먼저, 같은 종류끼리는 이름순(로케일에 기대지 않는 단순 비교) */
function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** path의 조상 폴더 경로들을 루트에 가까운 순서로. 파일 자신이나 최상위 파일이면 빈 배열 */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  let current = '';
  for (let index = 0; index < parts.length - 1; index++) {
    current = current ? `${current}/${parts[index]}` : parts[index]!;
    ancestors.push(current);
  }
  return ancestors;
}
