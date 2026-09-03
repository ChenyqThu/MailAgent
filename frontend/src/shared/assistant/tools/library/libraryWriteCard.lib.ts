// LibraryWriteCard 的纯逻辑面（`_cardShell.lib.ts` / `imageGenCard.lib.ts` 先例）：
// react-refresh/only-export-components 要求带组件的文件只导出组件，所以读参数、判文件形态、
// 拼标题这些零 JSX 的活放这里。

/** 四个资料库写工具在卡片里的形态。与 `GATEWAY_LIBRARY_WRITE_TOOL_NAMES` 一一对应，
 *  多一个少一个由 ComponentRegistry.test.tsx 判。 */
export type LibraryWriteShape = 'create' | 'overwrite' | 'append' | 'move' | 'delete'

export interface LibraryWriteInput {
  shape: LibraryWriteShape
  /** 目标路径。create/move/delete 直接来自模型参数；overwrite/append 只有 file_id，
   *  由卡片查一次库补上（拿不到时留 null，卡片退回显示 `#id`）。 */
  path: string | null
  /** overwrite / append / move / delete 的目标行。 */
  fileId: number | null
  /** move 的落点。 */
  targetPath: string | null
  /** 写入正文（create / overwrite = 完整新正文，append = 追加片段）。 */
  content: string | null
  changeNote: string | null
  /** overwrite 是否带了 CAS 基线 —— 没带就是「不看当前版本直接盖」，值得在卡上说一句。 */
  hasExpectedHash: boolean
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

/** 流式阶段 `args` 可能是半个对象、`argsText` 可能还解析不了 —— 每个字段各自降级成
 *  null，绝不抛（抛了整张卡就没了，而这张卡正是用户唯一的批准入口）。 */
export function readLibraryWriteInput(
  toolName: string,
  args: unknown,
  argsText: string | undefined
): LibraryWriteInput {
  let obj = asRecord(args)
  if (!obj && argsText) {
    try {
      obj = asRecord(JSON.parse(argsText))
    } catch {
      obj = null
    }
  }
  const mode = str(obj?.mode)
  const shape: LibraryWriteShape =
    toolName === 'library_append'
      ? 'append'
      : toolName === 'library_move'
        ? 'move'
        : toolName === 'library_delete'
          ? 'delete'
          : mode === 'overwrite'
            ? 'overwrite'
            : 'create'
  return {
    shape,
    path: str(obj?.path),
    fileId: int(obj?.file_id),
    targetPath: str(obj?.target_path),
    content: typeof obj?.content === 'string' ? obj.content : null,
    changeNote: str(obj?.change_note),
    hasExpectedHash: str(obj?.expected_hash) !== null
  }
}

/** 正文该不该按 markdown 渲染 —— 只看目标文件的扩展名。把 `.html` / `.csv` / `.json`
 *  的源码丢给 markdown 渲染器只会把它渲染坏，那几类原样显示才是对的。
 *  路径未知（overwrite/append 还没查回来）时按 markdown 渲染：库里写面的主力是 `.md`，
 *  而对纯文本按 markdown 渲染最多是少几个换行，反过来会把标题列表全压成一行。 */
export function rendersAsMarkdown(path: string | null): boolean {
  if (path === null) return true
  const dot = path.lastIndexOf('.')
  if (dot < 0) return true
  const ext = path.slice(dot).toLowerCase()
  return ext === '.md' || ext === '.markdown' || ext === '.txt'
}

/** 卡片标题 / 正文段落的 i18n key 后缀。 */
export const LIBRARY_WRITE_COPY_KEY: Record<LibraryWriteShape, string> = {
  create: 'create',
  overwrite: 'overwrite',
  append: 'append',
  move: 'move',
  delete: 'delete'
}
