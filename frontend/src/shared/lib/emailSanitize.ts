// 邮件 HTML 消毒 —— 阅读区 (EmailBodyFrame) 与 compose 发送拼回的原文引用块共用同一套
// 硬化规则。单一来源避免两处各自维护漂移; 保证「预览所见 = 实际发送」(compose 引用块
// 渲染与发送走同一 sanitize 配置)。
//
// 独立回归守护见 tests/components/dompurify_xss.test.ts —— 该文件故意 mirror 一份配置
// 断言典型 XSS 向量被剥离, 若此处漂移测试会失败。
import DOMPurify from 'dompurify'

// 仅允许 image/* 的 data: URI (防 `data:text/html` 注入), 外加常见安全 scheme。
// 缺它默认 regex 会把 `data:image/png;base64,...` 内联图也剥掉。
export const SAFE_EMAIL_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|data:image\/(?:png|jpe?g|gif|webp|svg\+xml|heic)):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

// 🔴 减面优先：能删的能力不要去覆盖它（0903 返工批三）。
// 远程图片的「默认拦截 / 显式放行」闸（emailRemoteImages.ts）判据是「哪些写法会发请求」——
// 每补一个属性就多一种绕法，三轮复核换了三种 markup 就绕过三次。可靠的收敛是**把能力删掉**：
// 邮件正文里没有任何客户端可靠支持 <video>/<audio>/<track>（正文 iframe 无 allow-scripts，
// 这些元素本来也放不了），删掉零功能损失，同时消灭 poster / src / 媒体 <source> 一整片出网面。
//   ⚠️ DOMPurify 3.x 的 video/audio 在默认 FORBID_CONTENTS 里 ⇒ 连子树一起删（<source>/<track>
//      不会留下裸壳）；但**独立**的 `<source src>`（不在 video/audio 里）仍会留下，那条由
//      emailRemoteImages 无条件摘掉 —— <picture> 里的 source 用 srcset，src 本就被浏览器忽略。
// link / base / meta / object / embed / input[type=image] / <svg> 系列（image[href] / use[href] /
// feImage）实测已被 `USE_PROFILES: { html: true }` 的白名单挡在外面；前四个显式写进 FORBID 是为了
// 让「不允许」是本配置自己的断言，而不是依赖 DOMPurify profile 的内部构成。
export const EMAIL_PURIFY_OPTS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'video',
    'audio',
    'track',
    'link',
    'base',
    'meta'
  ],
  FORBID_ATTR: ['target', 'onerror', 'onclick', 'onload'],
  ALLOWED_URI_REGEXP: SAFE_EMAIL_URI_REGEXP
}

/** 硬化 sanitize: 渲染 / 发送不可信邮件 HTML (原文引用块等) 时用, 与阅读区同配置。 */
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, EMAIL_PURIFY_OPTS)
}
