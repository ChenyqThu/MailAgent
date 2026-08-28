// Build-time 注入的构建标识（electron.vite.config renderer.define：__GIT_HASH__ /
// __BUILD_TIME__）。放 src/shared 让 tsconfig.node + tsconfig.web 都能见：两个 tsconfig
// 都 include `src/shared/**`，declare 放 renderer/env.d.ts 时 node 侧（不 include
// renderer）会 TS2304。web build（vite.web.config）不注入这两个常量 → 消费方一律用
// `typeof __GIT_HASH__ !== 'undefined'` guard 运行时退化为 ''。
//
// ⚠️ 08-27 标签工作区批：唯一的消费方 StatusBar 随底部状态条退役删除，这两个常量目前
// **没有消费点**（define 仍在注入）。是否把 buildId/buildTime 挂到设置域面板 footer 待
// owner 定；定不挂就把这两个 declare 与 electron.vite.config 的 define 一起删。
declare const __GIT_HASH__: string
declare const __BUILD_TIME__: string
