// 灵动 bot 头像 v2 —— 3D 姿态与投影渲染层。
// 移植自 avatar-lab `src/features/avatar/geometry.ts`（AGPL-3.0 上游，出处注记见
// frontend/docs/bot-avatar.md）。裁剪面：去掉 Studio 编辑器专属（eye/body 编辑器
// 几何、arcball、gizmo、平移/旋转操纵）与 wireframe。
// 保留：四元数姿态、透视投影、眼睛贴合曲面（含眨眼高度插值）、8 原语头部轮廓路径、
// mickey 耳朵 / cursor 锥体两个内建复合背层、body accessories（附属曲面：成品
// avatar 的天线/云朵/太阳芒等，逐帧按相机深度分背/前两层并 z 排序 —— 与 lab
// accessoryLayers 同款算法）。
// 本文件 framework-agnostic：纯数学，零 React / 零 DOM。
//
// 坐标系：画布中心 (0,0)，viewBox `-150 -150 300 300`（shapes.ts BOT_VIEW_BOX）。

import { cursorLayout, surfaceFrontSampleAt, surfacePointAt } from './surfaces'
import type { Point3, SurfaceConfig } from './surfaces'

export type Quaternion = readonly [number, number, number, number]

/** 眼睛空闲微动模式（ambient.ts 消费；'none' = 静止） */
export type EyeMotion = 'none' | 'microSaccades' | 'shake'
/** 身体空闲微动模式 */
export type BodyMotion = 'none' | 'slowDrift' | 'shake'

/**
 * v2 表情 = 15 个数值参数（v1 是烘焙的 48 点轮廓）。
 * head* 是头部欧拉角（度）；width/height/position/angle 是双眼独立参数
 * （规范脸面坐标系，见 canonicalFaceCoordinates）；spacing 是双眼间距；
 * perspective 是透视强度（0 = 正交）。
 */
export interface Expression {
  id: string
  headX: number
  headY: number
  headZ: number
  widthLeft: number
  widthRight: number
  heightLeft: number
  heightRight: number
  spacing: number
  positionXLeft: number
  positionXRight: number
  positionYLeft: number
  positionYRight: number
  leftAngle: number
  rightAngle: number
  perspective: number
}

export type ExpressionNumericField = Exclude<keyof Expression, 'id'>

/** 过渡插值遍历的数值字段全集（引擎逐字段 lerp 的依据） */
export const expressionFields: ExpressionNumericField[] = [
  'headX',
  'headY',
  'headZ',
  'widthLeft',
  'widthRight',
  'heightLeft',
  'heightRight',
  'spacing',
  'positionXLeft',
  'positionXRight',
  'positionYLeft',
  'positionYRight',
  'leftAngle',
  'rightAngle',
  'perspective'
]

export interface AvatarPose {
  expression: Expression
  orientation: Quaternion
}

/**
 * 附属曲面（组合身体单元）：成品 avatar 的天线/云朵/太阳芒。
 * 数据来自 avatar-lab studio 文档的 body.nodes（裁掉编辑器专属的 id/name）；
 * position/rotation 是头部本地坐标系（跟随头部姿态整体转动）。
 */
export interface BodyNodeDef {
  surface: SurfaceConfig
  position: Point3
  rotation: Point3
}

/** renderAvatar 的一帧几何产物（全部是可直接进 <path d> 的字符串） */
export interface AvatarGeometry {
  /** 头部轮廓（同一串同时用作眼睛 clipPath） */
  headPath: string
  /** 头后背层（mickey 耳朵 / cursor 锥体 + 判定在头后的附属曲面，按深度升序） */
  backPaths: string[]
  /** 判定转到头前的附属曲面（渲染在眼睛之上；多数帧为空） */
  frontPaths: string[]
  leftPath: string
  rightPath: string
  leftVisible: boolean
  rightVisible: boolean
}

/** 规范脸面坐标的球面半径（表情参数的公共坐标系，换曲面不换表情） */
export const RADIUS = 120
const FOCAL_LENGTH = 620
const QUARTER_ARC_SAMPLES = 14

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

export const radians = (degrees: number): number => (degrees * Math.PI) / 180

const normalizeQuaternion = ([w, x, y, z]: Quaternion): Quaternion => {
  const length = Math.hypot(w, x, y, z) || 1
  return [w / length, x / length, y / length, z / length]
}

const multiplyQuaternions = (
  [aw, ax, ay, az]: Quaternion,
  [bw, bx, by, bz]: Quaternion
): Quaternion =>
  normalizeQuaternion([
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw
  ])

const quaternionFromAxisAngle = ([x, y, z]: Point3, angle: number): Quaternion => {
  const halfAngle = angle / 2
  const sine = Math.sin(halfAngle)
  return normalizeQuaternion([Math.cos(halfAngle), x * sine, y * sine, z * sine])
}

const quaternionFromEuler = (x: number, y: number, z: number): Quaternion => {
  const xRotation = quaternionFromAxisAngle([1, 0, 0], x)
  const yRotation = quaternionFromAxisAngle([0, 1, 0], y)
  const zRotation = quaternionFromAxisAngle([0, 0, 1], z)
  return multiplyQuaternions(multiplyQuaternions(zRotation, xRotation), yRotation)
}

const rotateWithQuaternion = ([w, x, y, z]: Quaternion, [px, py, pz]: Point3): Point3 => {
  const tx = 2 * (y * pz - z * py)
  const ty = 2 * (z * px - x * pz)
  const tz = 2 * (x * py - y * px)
  return [
    px + w * tx + (y * tz - z * ty),
    py + w * ty + (z * tx - x * tz),
    pz + w * tz + (x * ty - y * tx)
  ]
}

/**
 * 角度就近解析：过渡目标角折到与当前值差 ≤180° 的等价角（-370° 与 -10° 同向），
 * 防止表情切换时头部绕远路转一整圈。
 */
export const nearestEquivalentAngle = (angle: number, current: number): number => {
  let result = angle
  while (result - current > 180) result -= 360
  while (result - current < -180) result += 360
  return clamp(result, -365, 365)
}

export const poseFromExpression = (expression: Expression): AvatarPose => ({
  expression,
  orientation: quaternionFromEuler(
    radians(expression.headX),
    radians(expression.headY),
    radians(expression.headZ)
  )
})

// ── 眼睛：圆角矩形 → 规范脸面坐标 → 曲面贴合 → 透视投影 ─────────────────────────

const roundedRectangle = (width: number, height: number): (readonly [number, number])[] => {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const cornerRadius = Math.min(halfHeight, halfWidth)
  const points: (readonly [number, number])[] = []
  const addLine = (start: readonly [number, number], end: readonly [number, number]): void => {
    const samples = Math.max(2, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 1.5))
    for (let index = 0; index < samples; index += 1) {
      const progress = index / samples
      points.push([
        start[0] + (end[0] - start[0]) * progress,
        start[1] + (end[1] - start[1]) * progress
      ])
    }
  }
  const addArc = (centerX: number, centerY: number, startAngle: number): void => {
    for (let index = 0; index < QUARTER_ARC_SAMPLES; index += 1) {
      const angle = startAngle + (index / QUARTER_ARC_SAMPLES) * (Math.PI / 2)
      points.push([centerX + Math.cos(angle) * cornerRadius, centerY + Math.sin(angle) * cornerRadius])
    }
  }
  addLine([-halfWidth + cornerRadius, -halfHeight], [halfWidth - cornerRadius, -halfHeight])
  addArc(halfWidth - cornerRadius, -halfHeight + cornerRadius, -Math.PI / 2)
  addLine([halfWidth, -halfHeight + cornerRadius], [halfWidth, halfHeight - cornerRadius])
  addArc(halfWidth - cornerRadius, halfHeight - cornerRadius, 0)
  addLine([halfWidth - cornerRadius, halfHeight], [-halfWidth + cornerRadius, halfHeight])
  addArc(-halfWidth + cornerRadius, halfHeight - cornerRadius, Math.PI / 2)
  addLine([-halfWidth, halfHeight - cornerRadius], [-halfWidth, -halfHeight + cornerRadius])
  addArc(-halfWidth + cornerRadius, -halfHeight + cornerRadius, Math.PI)
  return points
}

const project = (point: Point3, perspective: number): Point3 => {
  const denominator = FOCAL_LENGTH - point[2] * perspective
  const scale = Math.abs(denominator) < 0.0001 ? FOCAL_LENGTH / 0.0001 : FOCAL_LENGTH / denominator
  return [point[0] * scale, point[1] * scale, point[2]]
}

const path = (points: Point3[], close = true): string => {
  if (!points.length) return ''
  return `M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}${points
    .slice(1)
    .map((point) => `L${point[0].toFixed(2)} ${point[1].toFixed(2)}`)
    .join('')}${close ? 'Z' : ''}`
}

interface ProjectedSurfacePoint {
  point: Point3
  normal: Point3
}

/** 规范脸面坐标 → 球面经纬展开（表情跨曲面兼容的关键一跳） */
const canonicalFaceCoordinates = (x: number, y: number): readonly [number, number] => {
  const longitude = x / RADIUS
  const latitude = y / RADIUS
  return [RADIUS * Math.cos(latitude) * Math.sin(longitude), RADIUS * Math.sin(latitude)]
}

const projectFacePoint = (
  pose: AvatarPose,
  surface: SurfaceConfig,
  x: number,
  y: number
): ProjectedSurfacePoint => {
  const [faceX, faceY] = canonicalFaceCoordinates(x, y)
  const sample = surfaceFrontSampleAt(surface, faceX, faceY)
  return {
    point: project(rotateWithQuaternion(pose.orientation, sample.point), pose.expression.perspective),
    normal: rotateWithQuaternion(pose.orientation, sample.normal)
  }
}

/** 眨眼进眼几何：高度插值到 5px 下限（v1 是 scaleY 压缩——v2 眨眼中眼形保持圆角） */
const EYE_BLINK_MIN_HEIGHT = 5

const eyePoints = (
  pose: AvatarPose,
  surface: SurfaceConfig,
  side: -1 | 1,
  blink: number
): ProjectedSurfacePoint[] => {
  const expression = pose.expression
  const suffix = side < 0 ? 'Left' : 'Right'
  const width = expression[`width${suffix}`]
  const restingHeight = expression[`height${suffix}`]
  const height = EYE_BLINK_MIN_HEIGHT + (restingHeight - EYE_BLINK_MIN_HEIGHT) * blink
  const centerX = (side * expression.spacing) / 2 + expression[`positionX${suffix}`]
  const centerY = expression[`positionY${suffix}`]
  const angle = radians(side < 0 ? expression.leftAngle : expression.rightAngle)
  return roundedRectangle(width, height).map(([localX, localY]) => {
    const rotatedX = localX * Math.cos(angle) - localY * Math.sin(angle)
    const rotatedY = localX * Math.sin(angle) + localY * Math.cos(angle)
    return projectFacePoint(pose, surface, centerX + rotatedX, centerY + rotatedY)
  })
}

// ── 头部轮廓：按原语类型选专用投影或经纬采样凸包 ─────────────────────────────────

const MAX_SURFACE_CACHE_ENTRIES = 24
const HEAD_LATITUDE_SAMPLES = 25
const HEAD_LONGITUDE_SAMPLES = 73
const PRIMITIVE_RING_SAMPLES = 144
const ROUNDED_PRIMITIVE_LATITUDE_SAMPLES = 33
const ROUNDED_PRIMITIVE_LONGITUDE_SAMPLES = 73
const headSamplesCache = new Map<string, Point3[]>()

const surfaceCacheKey = (surface: SurfaceConfig): string =>
  [
    surface.type,
    surface.width,
    surface.height,
    surface.depth,
    surface.roundness,
    surface.morphRoundness,
    surface.tipRoundness,
    surface.baseRoundness
  ]
    .map((value) => (typeof value === 'number' ? value.toFixed(4) : value))
    .join(':')

const cacheSurfaceValue = <Value,>(cache: Map<string, Value>, key: string, value: Value): Value => {
  if (cache.size >= MAX_SURFACE_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
  cache.set(key, value)
  return value
}

const projectLocalPoint = (pose: AvatarPose, point: Point3): Point3 =>
  project(rotateWithQuaternion(pose.orientation, point), pose.expression.perspective)

const convexHull = (points: Point3[]): Point3[] => {
  const sorted = [...points].sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const cross = (origin: Point3, first: Point3, second: Point3): number =>
    (first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0])
  const half = (source: Point3[]): Point3[] => {
    const result: Point3[] = []
    source.forEach((point) => {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop()
      result.push(point)
    })
    return result
  }
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)]
}

const smoothClosedPath = (points: Point3[]): string => {
  if (points.length < 3) return path(points)
  const pointAt = (index: number): Point3 => points[(index + points.length) % points.length]
  return `M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}${points
    .map((point, index) => {
      const previous = pointAt(index - 1)
      const next = pointAt(index + 1)
      const afterNext = pointAt(index + 2)
      const firstControl: Point3 = [
        point[0] + (next[0] - previous[0]) / 6,
        point[1] + (next[1] - previous[1]) / 6,
        point[2]
      ]
      const secondControl: Point3 = [
        next[0] - (afterNext[0] - point[0]) / 6,
        next[1] - (afterNext[1] - point[1]) / 6,
        next[2]
      ]
      return `C${firstControl[0].toFixed(2)} ${firstControl[1].toFixed(2)} ${secondControl[0].toFixed(2)} ${secondControl[1].toFixed(2)} ${next[0].toFixed(2)} ${next[1].toFixed(2)}`
    })
    .join('')}Z`
}

const densifyClosedPoints = (points: Point3[], maximumDistance = 7): Point3[] =>
  points.flatMap((point, index) => {
    const next = points[(index + 1) % points.length]
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(next[0] - point[0], next[1] - point[1]) / maximumDistance)
    )
    return Array.from({ length: steps }, (_, step) => {
      const progress = step / steps
      return [
        point[0] + (next[0] - point[0]) * progress,
        point[1] + (next[1] - point[1]) * progress,
        point[2] + (next[2] - point[2]) * progress
      ] as Point3
    })
  })

const smoothOpenPath = (points: Point3[]): string => {
  if (!points.length) return ''
  if (points.length === 1) return `${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`
  return points
    .slice(0, -1)
    .map((point, index) => {
      const previous = points[Math.max(0, index - 1)]
      const next = points[index + 1]
      const afterNext = points[Math.min(points.length - 1, index + 2)]
      const firstControlX = point[0] + (next[0] - previous[0]) / 6
      const firstControlY = point[1] + (next[1] - previous[1]) / 6
      const secondControlX = next[0] - (afterNext[0] - point[0]) / 6
      const secondControlY = next[1] - (afterNext[1] - point[1]) / 6
      return `C${firstControlX.toFixed(2)} ${firstControlY.toFixed(2)} ${secondControlX.toFixed(2)} ${secondControlY.toFixed(2)} ${next[0].toFixed(2)} ${next[1].toFixed(2)}`
    })
    .join('')
}

const ringPoints = (width: number, depth: number, y: number): Point3[] =>
  Array.from({ length: PRIMITIVE_RING_SAMPLES + 1 }, (_, index) => {
    const angle = (index / PRIMITIVE_RING_SAMPLES) * Math.PI * 2
    return [(width / 2) * Math.sin(angle), y, (depth / 2) * Math.cos(angle)] as Point3
  })

const projectedRoundedPrimitivePath = (pose: AvatarPose, surface: SurfaceConfig): string => {
  const key = surfaceCacheKey(surface)
  let localSamples = headSamplesCache.get(key)
  if (!localSamples) {
    localSamples = Array.from({ length: ROUNDED_PRIMITIVE_LATITUDE_SAMPLES }, (_, latitudeIndex) => {
      const latitude =
        -Math.PI / 2 + (latitudeIndex / (ROUNDED_PRIMITIVE_LATITUDE_SAMPLES - 1)) * Math.PI
      return Array.from({ length: ROUNDED_PRIMITIVE_LONGITUDE_SAMPLES }, (_, longitudeIndex) => {
        const longitude =
          -Math.PI + (longitudeIndex / (ROUNDED_PRIMITIVE_LONGITUDE_SAMPLES - 1)) * Math.PI * 2
        return surfacePointAt(surface, longitude, latitude)
      })
    }).flat()
    cacheSurfaceValue(headSamplesCache, key, localSamples)
  }
  const projected = localSamples.map((point) => projectLocalPoint(pose, point))
  return smoothClosedPath(densifyClosedPoints(convexHull(projected)))
}

const projectedCylinderPath = (pose: AvatarPose, surface: SurfaceConfig): string => {
  if (surface.roundness > 0 || (surface.morphRoundness ?? 0) > 0) {
    return projectedRoundedPrimitivePath(pose, surface)
  }
  const halfHeight = surface.height / 2
  const projected = [
    ...ringPoints(surface.width, surface.depth, -halfHeight),
    ...ringPoints(surface.width, surface.depth, halfHeight)
  ].map((point) => projectLocalPoint(pose, point))
  return smoothClosedPath(densifyClosedPoints(convexHull(projected)))
}

const projectedCursorBodyPath = (pose: AvatarPose, surface: SurfaceConfig): string => {
  const layout = cursorLayout(surface)
  const halfHeight = layout.bodyHeight / 2
  const projected = [
    ...ringPoints(layout.bodyWidth, layout.bodyDepth, layout.bodyCenterY - halfHeight),
    ...ringPoints(layout.bodyWidth, layout.bodyDepth, layout.bodyCenterY + halfHeight)
  ].map((point) => projectLocalPoint(pose, point))
  return smoothClosedPath(densifyClosedPoints(convexHull(projected)))
}

const projectedCursorConePath = (pose: AvatarPose, surface: SurfaceConfig): string => {
  const layout = cursorLayout(surface)
  const apex = projectLocalPoint(pose, [0, layout.coneApexY, 0])
  const base = ringPoints(surface.width, surface.depth, layout.coneBaseY).map((point) =>
    projectLocalPoint(pose, point)
  )
  return smoothClosedPath(densifyClosedPoints(convexHull([...base, apex])))
}

const projectedConePath = (pose: AvatarPose, surface: SurfaceConfig): string => {
  if (
    (surface.morphRoundness ?? 0) > 0 ||
    (surface.tipRoundness ?? 0) > 0 ||
    (surface.baseRoundness ?? 0) > 0
  ) {
    return projectedRoundedPrimitivePath(pose, surface)
  }

  const apex = projectLocalPoint(pose, [0, -surface.height / 2, 0])
  const base = ringPoints(surface.width, surface.depth, surface.height / 2).map((point) =>
    projectLocalPoint(pose, point)
  )
  const hull = convexHull([...base, apex])
  const apexIndex = hull.findIndex(
    (point) => Math.hypot(point[0] - apex[0], point[1] - apex[1]) < 0.01
  )
  if (apexIndex < 0) return smoothClosedPath(hull)

  const ordered = [...hull.slice(apexIndex), ...hull.slice(0, apexIndex)]
  const baseArc = ordered.slice(1)
  if (baseArc.length < 2) return path(hull)
  return `M${apex[0].toFixed(2)} ${apex[1].toFixed(2)}L${baseArc[0][0].toFixed(2)} ${baseArc[0][1].toFixed(2)}${smoothOpenPath(baseArc)}L${apex[0].toFixed(2)} ${apex[1].toFixed(2)}Z`
}

const projectedCubePath = (pose: AvatarPose, surface: SurfaceConfig): string => {
  if (surface.roundness > 0) return projectedRoundedPrimitivePath(pose, surface)
  const halfWidth = surface.width / 2
  const halfHeight = surface.height / 2
  const halfDepth = surface.depth / 2
  const vertices = [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) => [-1, 1].map((z) => [x * halfWidth, y * halfHeight, z * halfDepth] as Point3))
  )
  return path(convexHull(vertices.map((point) => projectLocalPoint(pose, point))))
}

const projectedDiamondPath = (pose: AvatarPose, surface: SurfaceConfig): string => {
  if (surface.roundness > 0) return projectedRoundedPrimitivePath(pose, surface)
  const halfWidth = surface.width / 2
  const halfHeight = surface.height / 2
  const halfDepth = surface.depth / 2
  const vertices: Point3[] = [
    [-halfWidth, 0, 0],
    [halfWidth, 0, 0],
    [0, -halfHeight, 0],
    [0, halfHeight, 0],
    [0, 0, -halfDepth],
    [0, 0, halfDepth]
  ]
  return path(convexHull(vertices.map((point) => projectLocalPoint(pose, point))))
}

// ── 椭球精确投影（sphere/mickey/capsule 的头部轮廓走解析解，比采样凸包又快又准）──

interface ProjectedEllipse {
  centerX: number
  centerY: number
  majorRadius: number
  minorRadius: number
  rotation: number
}

const ellipseProjection = (
  centerX: number,
  centerY: number,
  covarianceXX: number,
  covarianceXY: number,
  covarianceYY: number
): ProjectedEllipse | null => {
  const trace = covarianceXX + covarianceYY
  const difference = Math.hypot(covarianceXX - covarianceYY, covarianceXY * 2)
  const majorSquared = (trace + difference) / 2
  const minorSquared = (trace - difference) / 2
  if (majorSquared <= 0 || minorSquared <= 0) return null

  return {
    centerX,
    centerY,
    majorRadius: Math.sqrt(majorSquared),
    minorRadius: Math.sqrt(minorSquared),
    rotation: Math.atan2(covarianceXY * 2, covarianceXX - covarianceYY) / 2
  }
}

const ellipsePath = ({ centerX, centerY, majorRadius, minorRadius, rotation }: ProjectedEllipse): string => {
  const rotationDegrees = (rotation * 180) / Math.PI
  const offsetX = Math.cos(rotation) * majorRadius
  const offsetY = Math.sin(rotation) * majorRadius
  const startX = centerX + offsetX
  const startY = centerY + offsetY
  const endX = centerX - offsetX
  const endY = centerY - offsetY

  return `M${startX.toFixed(2)} ${startY.toFixed(2)}A${majorRadius.toFixed(2)} ${minorRadius.toFixed(2)} ${rotationDegrees.toFixed(2)} 0 1 ${endX.toFixed(2)} ${endY.toFixed(2)}A${majorRadius.toFixed(2)} ${minorRadius.toFixed(2)} ${rotationDegrees.toFixed(2)} 0 1 ${startX.toFixed(2)} ${startY.toFixed(2)}Z`
}

const projectedEllipsoid = (
  pose: AvatarPose,
  axes: Point3,
  localCenter: Point3 = [0, 0, 0]
): ProjectedEllipse | null => {
  const rotatedAxes = [
    rotateWithQuaternion(pose.orientation, [1, 0, 0]),
    rotateWithQuaternion(pose.orientation, [0, 1, 0]),
    rotateWithQuaternion(pose.orientation, [0, 0, 1])
  ]
  const center = rotateWithQuaternion(pose.orientation, localCenter)

  if (Math.abs(pose.expression.perspective) < 0.0001) {
    const covarianceXX = rotatedAxes.reduce(
      (total, axis, index) => total + axis[0] * axis[0] * axes[index] * axes[index],
      0
    )
    const covarianceXY = rotatedAxes.reduce(
      (total, axis, index) => total + axis[0] * axis[1] * axes[index] * axes[index],
      0
    )
    const covarianceYY = rotatedAxes.reduce(
      (total, axis, index) => total + axis[1] * axis[1] * axes[index] * axes[index],
      0
    )
    return ellipseProjection(center[0], center[1], covarianceXX, covarianceXY, covarianceYY)
  }

  const inverseAxesSquared = axes.map((axis) => 1 / (axis * axis))
  const quadratic = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, column) =>
      rotatedAxes.reduce(
        (total, axis, index) => total + axis[row] * inverseAxesSquared[index] * axis[column],
        0
      )
    )
  )
  const focalLength = FOCAL_LENGTH / pose.expression.perspective
  const cameraOffset: Point3 = [-center[0], -center[1], focalLength - center[2]]
  const cameraNormal: Point3 = [
    quadratic[0][0] * cameraOffset[0] + quadratic[0][1] * cameraOffset[1] + quadratic[0][2] * cameraOffset[2],
    quadratic[1][0] * cameraOffset[0] + quadratic[1][1] * cameraOffset[1] + quadratic[1][2] * cameraOffset[2],
    quadratic[2][0] * cameraOffset[0] + quadratic[2][1] * cameraOffset[1] + quadratic[2][2] * cameraOffset[2]
  ]
  const cameraTerm =
    cameraOffset[0] * cameraNormal[0] +
    cameraOffset[1] * cameraNormal[1] +
    cameraOffset[2] * cameraNormal[2] -
    1
  const tangentLinear = [cameraNormal[0], cameraNormal[1], -focalLength * cameraNormal[2]]
  const rayQuadratic = [
    [quadratic[0][0], quadratic[0][1], -focalLength * quadratic[0][2]],
    [quadratic[1][0], quadratic[1][1], -focalLength * quadratic[1][2]],
    [
      -focalLength * quadratic[2][0],
      -focalLength * quadratic[2][1],
      focalLength * focalLength * quadratic[2][2]
    ]
  ]
  const conic = Array.from({ length: 3 }, (_, row) =>
    Array.from(
      { length: 3 },
      (_, column) => tangentLinear[row] * tangentLinear[column] - cameraTerm * rayQuadratic[row][column]
    )
  )
  const determinant = conic[0][0] * conic[1][1] - conic[0][1] * conic[0][1]
  if (Math.abs(determinant) < 1e-12) return null

  const centerX = -(conic[1][1] * conic[0][2] - conic[0][1] * conic[1][2]) / determinant
  const centerY = (conic[0][1] * conic[0][2] - conic[0][0] * conic[1][2]) / determinant
  const centeredConstant = conic[2][2] + conic[0][2] * centerX + conic[1][2] * centerY
  const scale = -centeredConstant
  if (Math.abs(scale) < 1e-12) return null

  const shapeXX = conic[0][0] / scale
  const shapeXY = conic[0][1] / scale
  const shapeYY = conic[1][1] / scale
  const shapeDeterminant = shapeXX * shapeYY - shapeXY * shapeXY
  if (shapeDeterminant <= 0) return null

  return ellipseProjection(
    centerX,
    centerY,
    shapeYY / shapeDeterminant,
    -shapeXY / shapeDeterminant,
    shapeXX / shapeDeterminant
  )
}

const projectedEllipsoidPath = (pose: AvatarPose, surface: SurfaceConfig): string | null => {
  const ellipse = projectedEllipsoid(pose, [surface.width / 2, surface.height / 2, surface.depth / 2])
  const isSphere = surface.width === surface.height && surface.height === surface.depth
  if (ellipse && isSphere) {
    const radius = (ellipse.majorRadius + ellipse.minorRadius) / 2
    return ellipsePath({ centerX: 0, centerY: 0, majorRadius: radius, minorRadius: radius, rotation: 0 })
  }
  return ellipse ? ellipsePath(ellipse) : null
}

const mickeyEarPaths = (pose: AvatarPose, surface: SurfaceConfig): string[] => {
  if (surface.type !== 'mickey') return []
  const radius = Math.min(surface.width, surface.height) * 0.23
  const depthRadius = Math.min(radius, surface.depth * 0.29)
  const centerX = surface.width * 0.37
  const centerY = -surface.height * 0.39
  const centerZ = -surface.depth * 0.12
  const axes: Point3 = [radius, radius, depthRadius]
  return [-1, 1]
    .map((side) => projectedEllipsoid(pose, axes, [side * centerX, centerY, centerZ]))
    .filter((ear): ear is ProjectedEllipse => ear !== null)
    .map(ellipsePath)
}

const compositeBackPaths = (pose: AvatarPose, surface: SurfaceConfig): string[] => {
  if (surface.type === 'mickey') return mickeyEarPaths(pose, surface)
  if (surface.type === 'cursor') return [projectedCursorConePath(pose, surface)]
  return []
}

// ── 附属曲面（body accessories）：lab accessoryPath/accessoryLayers 同款 ─────────

/** 附属曲面采样密度低于头部（17×49 vs 33×73）——小体量原语，lab 同款取舍 */
const ACCESSORY_LATITUDE_SAMPLES = 17
const ACCESSORY_LONGITUDE_SAMPLES = 49
const accessorySamplesCache = new Map<string, Point3[]>()

const accessoryPath = (pose: AvatarPose, node: BodyNodeDef): string => {
  const key = surfaceCacheKey(node.surface)
  let localSamples = accessorySamplesCache.get(key)
  if (!localSamples) {
    localSamples = Array.from({ length: ACCESSORY_LATITUDE_SAMPLES }, (_, latitudeIndex) => {
      const latitude = -Math.PI / 2 + (latitudeIndex / (ACCESSORY_LATITUDE_SAMPLES - 1)) * Math.PI
      return Array.from({ length: ACCESSORY_LONGITUDE_SAMPLES }, (_, longitudeIndex) => {
        const longitude =
          -Math.PI + (longitudeIndex / (ACCESSORY_LONGITUDE_SAMPLES - 1)) * Math.PI * 2
        return surfacePointAt(node.surface, longitude, latitude)
      })
    }).flat()
    cacheSurfaceValue(accessorySamplesCache, key, localSamples)
  }

  const localOrientation = quaternionFromEuler(
    radians(node.rotation[0]),
    radians(node.rotation[1]),
    radians(node.rotation[2])
  )
  const projected = localSamples.map((point) => {
    const locallyRotated = rotateWithQuaternion(localOrientation, point)
    const positioned: Point3 = [
      locallyRotated[0] + node.position[0],
      locallyRotated[1] + node.position[1],
      locallyRotated[2] + node.position[2]
    ]
    return project(rotateWithQuaternion(pose.orientation, positioned), pose.expression.perspective)
  })
  const hull = convexHull(projected)
  if (
    (node.surface.type === 'cube' || node.surface.type === 'diamond') &&
    node.surface.roundness <= 0
  ) {
    return path(hull)
  }
  return smoothClosedPath(densifyClosedPoints(hull))
}

/** 附属曲面从「头后」跨到「头前」的深度阈值系数（lab 同款：超过自身相机深度半径的 10%） */
const ACCESSORY_FRONT_CROSSING_RATIO = 0.1

const accessoryCameraDepthRadius = (pose: AvatarPose, node: BodyNodeDef): number => {
  const localOrientation = quaternionFromEuler(
    radians(node.rotation[0]),
    radians(node.rotation[1]),
    radians(node.rotation[2])
  )
  const cameraDepthByAxis = (
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ] as Point3[]
  ).map(
    (axis) => rotateWithQuaternion(pose.orientation, rotateWithQuaternion(localOrientation, axis))[2]
  )
  return Math.hypot(
    cameraDepthByAxis[0] * (node.surface.width / 2),
    cameraDepthByAxis[1] * (node.surface.height / 2),
    cameraDepthByAxis[2] * (node.surface.depth / 2)
  )
}

/** 附属曲面逐帧分层：按相机深度升序，跨过阈值的划入前层（渲染在头/眼之上） */
const accessoryLayers = (
  pose: AvatarPose,
  nodes: readonly BodyNodeDef[]
): { backPaths: string[]; frontPaths: string[] } => {
  if (!nodes.length) return { backPaths: [], frontPaths: [] }
  const layers = nodes
    .map((node) => {
      const depth = rotateWithQuaternion(pose.orientation, node.position)[2]
      return {
        path: accessoryPath(pose, node),
        depth,
        front: depth > accessoryCameraDepthRadius(pose, node) * ACCESSORY_FRONT_CROSSING_RATIO
      }
    })
    .sort((left, right) => left.depth - right.depth)
  return {
    backPaths: layers.filter((layer) => !layer.front).map((layer) => layer.path),
    frontPaths: layers.filter((layer) => layer.front).map((layer) => layer.path)
  }
}

const ellipsePoints = (ellipse: ProjectedEllipse): Point3[] =>
  Array.from({ length: PRIMITIVE_RING_SAMPLES }, (_, index) => {
    const angle = (index / PRIMITIVE_RING_SAMPLES) * Math.PI * 2
    const major = Math.cos(angle) * ellipse.majorRadius
    const minor = Math.sin(angle) * ellipse.minorRadius
    return [
      ellipse.centerX + major * Math.cos(ellipse.rotation) - minor * Math.sin(ellipse.rotation),
      ellipse.centerY + major * Math.sin(ellipse.rotation) + minor * Math.cos(ellipse.rotation),
      0
    ] as Point3
  })

const smoothHullPath = (points: Point3[]): string => {
  if (points.length < 3) return path(points)
  const distances = points.map((point, index) => {
    const next = points[(index + 1) % points.length]
    return Math.hypot(next[0] - point[0], next[1] - point[1])
  })
  const sortedDistances = [...distances].sort((left, right) => left - right)
  const medianDistance = sortedDistances[Math.floor(sortedDistances.length / 2)] || 1
  const straightThreshold = Math.max(8, medianDistance * 3.5)
  const straightEdges = distances.map((distance) => distance > straightThreshold)

  return `M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}${points
    .map((point, index) => {
      const nextIndex = (index + 1) % points.length
      const next = points[nextIndex]
      if (straightEdges[index]) return `L${next[0].toFixed(2)} ${next[1].toFixed(2)}`
      const previous = straightEdges[(index - 1 + points.length) % points.length]
        ? point
        : points[(index - 1 + points.length) % points.length]
      const afterNext = straightEdges[nextIndex] ? next : points[(index + 2) % points.length]
      const firstControlX = point[0] + (next[0] - previous[0]) / 6
      const firstControlY = point[1] + (next[1] - previous[1]) / 6
      const secondControlX = next[0] - (afterNext[0] - point[0]) / 6
      const secondControlY = next[1] - (afterNext[1] - point[1]) / 6
      return `C${firstControlX.toFixed(2)} ${firstControlY.toFixed(2)} ${secondControlX.toFixed(2)} ${secondControlY.toFixed(2)} ${next[0].toFixed(2)} ${next[1].toFixed(2)}`
    })
    .join('')}Z`
}

const projectedCapsulePath = (pose: AvatarPose, surface: SurfaceConfig): string | null => {
  const radiusX = surface.width / 2
  const radiusY = Math.min(radiusX, surface.height / 2)
  const radiusZ = surface.depth / 2
  const straightHalf = Math.max(0, (surface.height - radiusY * 2) / 2)
  const axes: Point3 = [radiusX, radiusY, radiusZ]
  const top = projectedEllipsoid(pose, axes, [0, straightHalf, 0])
  const bottom = projectedEllipsoid(pose, axes, [0, -straightHalf, 0])
  if (!top || !bottom) return null
  return smoothHullPath(convexHull([...ellipsePoints(top), ...ellipsePoints(bottom)]))
}

const headPath = (pose: AvatarPose, surface: SurfaceConfig): string => {
  if (surface.type === 'sphere' || surface.type === 'mickey') {
    const exactPath = projectedEllipsoidPath(pose, surface)
    if (exactPath) return exactPath
  }
  if (surface.type === 'capsule') {
    const exactPath = projectedCapsulePath(pose, surface)
    if (exactPath) return exactPath
  }
  if (surface.type === 'cylinder') return projectedCylinderPath(pose, surface)
  if (surface.type === 'cursor') return projectedCursorBodyPath(pose, surface)
  if (surface.type === 'cone') return projectedConePath(pose, surface)
  if (surface.type === 'cube') return projectedCubePath(pose, surface)
  if (surface.type === 'diamond') return projectedDiamondPath(pose, surface)

  const key = surfaceCacheKey(surface)
  let localSamples = headSamplesCache.get(key)
  if (!localSamples) {
    localSamples = Array.from({ length: HEAD_LATITUDE_SAMPLES }, (_, latitudeIndex) => {
      const latitude = -Math.PI / 2 + (latitudeIndex / (HEAD_LATITUDE_SAMPLES - 1)) * Math.PI
      return Array.from({ length: HEAD_LONGITUDE_SAMPLES }, (_, longitudeIndex) => {
        const longitude = -Math.PI + (longitudeIndex / (HEAD_LONGITUDE_SAMPLES - 1)) * Math.PI * 2
        return surfacePointAt(surface, longitude, latitude)
      })
    }).flat()
    cacheSurfaceValue(headSamplesCache, key, localSamples)
  }
  const projectedSamples = localSamples.map((sample) => projectLocalPoint(pose, sample))
  return path(convexHull(projectedSamples))
}

/**
 * 一帧完整几何：头部轮廓 + 背/前层复合形与附属曲面 + 双眼（含眨眼与背面隐藏判定）。
 * blink ∈ [0,1]（1 = 全睁）；bodyNodes = 组合身体（shapes.ts SHAPES[shape].nodes）。
 */
export const renderAvatar = (
  pose: AvatarPose,
  surface: SurfaceConfig,
  blink = 1,
  bodyNodes: readonly BodyNodeDef[] = []
): AvatarGeometry => {
  const leftSamples = eyePoints(pose, surface, -1, blink)
  const rightSamples = eyePoints(pose, surface, 1, blink)
  const accessories = accessoryLayers(pose, bodyNodes)
  return {
    headPath: headPath(pose, surface),
    backPaths: [...compositeBackPaths(pose, surface), ...accessories.backPaths],
    frontPaths: accessories.frontPaths,
    leftPath: path(leftSamples.map((sample) => sample.point)),
    rightPath: path(rightSamples.map((sample) => sample.point)),
    // 眼睛整体法线朝后（转到脑后）即隐藏——逐点求和判定，边缘半可见时仍画（被 clip 裁）
    leftVisible: leftSamples.reduce((total, sample) => total + sample.normal[2], 0) > 0,
    rightVisible: rightSamples.reduce((total, sample) => total + sample.normal[2], 0) > 0
  }
}
