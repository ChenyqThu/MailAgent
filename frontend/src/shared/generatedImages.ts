// 生成图片的 gateway 路由前缀 —— **零依赖叶子**（无 import，无副作用）。
//
// 两侧都要认这个前缀，所以它不能留在 `ai-gateway/tools/image.ts` 里：
//   · 写侧：那个文件拼出 `${前缀}${file_id}` 放进工具结果的 `url`；
//   · 读侧：renderer 的 markdown 渲染层要认出这种**根相对**地址并补上 gateway 的 origin。
// 而 image.ts 顶层拉了 `node:fs/promises` / `ai`，renderer 不能 import 它。按 CLAUDE.md
// 「跨边界手抄常量先问能不能消灭镜像」的处方，常量下沉到这里由两侧共用，而不是抄一份加闸。

/** 生成图片只读路由的前缀（server.ts 注册）。完整地址 = 前缀 + file_id。 */
export const GENERATED_IMAGE_ROUTE_PREFIX = '/api/ai/generated/'

/** 这是不是一条指向生成图片的**根相对**地址。绝对地址（模型偶尔会写全）返 false ——
 *  那种已经能自己加载，不需要补 origin。 */
export function isGeneratedImagePath(url: string): boolean {
  return url.startsWith(GENERATED_IMAGE_ROUTE_PREFIX)
}
