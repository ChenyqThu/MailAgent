// Build-time 注入的构建标识（electron.vite.config renderer.define：__GIT_HASH__ /
// __BUILD_TIME__）。放 src/shared 让 tsconfig.node + tsconfig.web 都能见 —— StatusBar 在
// src/shared，两个 tsconfig 都 include `src/shared/**`，declare 放 renderer/env.d.ts 时
// node 侧（不 include renderer）会 TS2304。web build（vite.web.config）不注入这两个常量
// → 消费方 StatusBar 用 `typeof __GIT_HASH__ !== 'undefined'` guard 运行时退化为 ''。
declare const __GIT_HASH__: string
declare const __BUILD_TIME__: string
