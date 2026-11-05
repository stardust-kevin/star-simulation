# star-simulation

## English

### Project Overview
This repository contains the baseline monolithic implementation of a high-precision 3D printer simulator, entirely encapsulated within a single `index.html` file.

It is designed to serve as a **Software-in-the-Loop (SIL)** testing platform. Instead of connecting to physical hardware, host software (like Python-based G-code senders or LLM agents) can interface with this simulator to verify command parsing, kinematic behavior, and thermal physics.

### Current Architecture (Phase 1)
- **Single Page Application (SPA)**: Zero external dependencies (except local `three.min.js`), runs entirely in the browser.
- **Frontend**: HTML5, CSS3, Vanilla JS.
- **3D Engine**: Three.js for trajectory visualization, camera control, and WebGL clipping.
- **Core Logic**: Custom built G-code interpreter, Marlin firmware state machine, and kinematic planner.

### Key Features & Design

#### 1. Firmware Flow Control (Marlin Emulation)
- **Ring Buffer Simulation**: Simulates the 16-slot command buffer of real hardware. Supports blocking semantics (`M109`/`M190` will halt the queue until temperature is stable).
- **Command Cancellation**: Supports `M108` to gracefully skip temperature waits, and `M112` for emergency stops.
- **State Machine**: Full support for absolute/relative positioning (`G90`/`G91`), extrusion modes (`M82`/`M83`), and unit scaling (`G20`/`G21`).
- **Diagnostics**: Real-time responses to `M105` (temps), `M114` (coords), `M119` (endstops), and `M503` (firmware settings).

#### 2. Kinematics & Planner
- **Interpolation**: Linear moves (`G0`/`G1`) and circular arcs (`G2`/`G3` with I/J or R parameters).
- **Trapezoidal Acceleration**: Calculates speed based on Junction Deviation and axis acceleration limits.
- **Soft Endstops**: Prevents movement out of bounds by clamping coordinates (X/Y/Z) in real-time.
- **Pure E-Axis Filtering**: Correctly distinguishes true layer changes from pure extruder movements (like `G1 E5` without X/Y movement) to avoid false layer counting.

#### 3. Thermal Dynamics & Physics
- **PID Control**: Simulates hotend and heated bed temperature curves with integral anti-windup.
- **Thermal Runaway**: Auto-shuts down the heater if power is applied but temperature fails to rise within 20 seconds.
- **Ooze Control (Stringing)**: Renders realistic hotend ooze trails during non-extruding travel moves, with a 300mm distance-based fade-out to prevent visual artifacts.
- **Retraction**: Simulates `G10`/`G11` and `M207` (retraction length/speed), properly accounting for negative E-axis movements without rendering them as extrusion lines.

#### 4. UI/UX & Visualization
- **Layer Clipping**: A dynamic slider that uses WebGL Clipping Planes to slice the model visually along the Z-axis.
- **Density Histogram**: The progress bar features a white density block layout representing the execution density of G-code, overlaid with a semi-transparent blue progress fill and discrete layer tick marks.
- **Code Highlighter**: A synchronized editor that shows line numbers and highlights the currently executing G-code.
- **Gooey Drag System**: An interactive floating ball with SVG filters for collapsing/expanding the control panel.
- **Interactive CLI**: A built-in terminal to send manual G-codes and inspect live responses.
- **Dashboard**: Real-time telemetry including XYZE coordinates, nozzle/bed temps, buffer status, speed factor, flow factor, and ETA.

#### 5. Multi-Color & Rendering
- **Color Modes**: Single color, Z-gradient, Rainbow, and Multi-color.
- **Multi-color Support**: Reacts to `T0-T3` tool changes and `M600` filament swaps, updating the visual rendering stream dynamically.

---

## 中文

### 项目概述
本仓库包含了高精度 3D 打印机仿真器的基线单体实现，所有功能完整封装在一个 `index.html` 文件中。

它的定位是作为**软件在环 (SIL)** 测试平台。上位机软件（如 Python 编写的发送脚本或 LLM Agent）可以通过 TCP 连接此仿真器，以验证 G-code 指令解析、运动学行为和热力学物理模型，而无需连接真实的物理打印机。

### 当前架构 (阶段一)
- **单页应用 (SPA)**：除本地 `three.min.js` 外，零外部依赖，纯浏览器运行。
- **前端**：HTML5, CSS3, Vanilla JS。
- **3D 引擎**：基于 Three.js 实现轨迹渲染、相机控制和 WebGL 裁剪。
- **核心逻辑**：完全自主编写的 G-code 解释器、Marlin 固件状态机和运动规划器。

### 核心功能与设计

#### 1. 固件流控与状态机 (Marlin 仿真)
- **环形缓冲区模拟**：模拟真实硬件的 16 槽指令缓冲区。支持阻塞语义（`M109`/`M190` 会挂起队列，直到温度达到目标且稳定）。
- **指令干预**：支持 `M108` 优雅跳过温度等待，支持 `M112` 紧急停机。
- **状态机**：完整支持绝对/相对定位（`G90`/`G91`）、挤出模式（`M82`/`M83`）和单位换算（`G20`/`G21`）。
- **状态查询**：实时响应 `M105`（温度）、`M114`（坐标）、`M119`（限位开关）、`M503`（固件参数）等查询指令。

#### 2. 运动学与轨迹规划
- **插补算法**：直线运动（`G0`/`G1`）和圆弧插补（`G2`/`G3`，支持 I/J 或 R 参数）。
- **梯形加减速**：基于 Junction Deviation（拐角偏置）和轴加速度限制计算真实速度。
- **软限位**：实时限制并截断超出打印体积（X/Y/Z 轴）的指令。
- **纯 E 轴过滤**：在计算模型层数时，正确区分真实的 Z 轴抬升和纯挤出机测试动作（如 `G1 E5` 且无 XYZ 位移），防止层数误判。

#### 3. 热力学与物理仿真
- **PID 温控**：模拟喷嘴和热床的温度曲线，包含积分抗饱和处理。
- **热失控保护**：如果加热器全功率输出 20 秒后温度仍无法上升，将自动切断加热并报警。
- **拉丝/漏料特效 (Ooze)**：在高温（>180°C）空驶移动时，渲染逼真的漏料拉丝轨迹，并在 300mm 距离内逐渐变淡，避免视觉杂乱。
- **回抽模拟**：支持 `G10`/`G11` 及 `M207`（设置回抽长度/速度），正确扣除 E 轴负向移动，且不会将回抽动作渲染为挤出线。

#### 4. UI 交互与可视化
- **分层剖切预览**：通过 WebGL 裁剪平面 (Clipping Plane) 和滑块，在视觉上沿 Z 轴剖切模型。
- **指令密度直方图**：进度条底层使用纯白色块显示 G-code 的执行密度，表层覆盖半透明的蓝色进度条和黑色的层分割线。
- **代码高亮追踪**：同步显示的代码编辑器，带有行号，并高亮当前正在执行的 G-code 行。
- **Gooey 拖拽球**：使用 SVG 滤镜实现的液体粘连悬浮球，用于折叠/展开控制面板。
- **交互式终端**：内置 CLI，可手动发送 G-code 并查看实时响应。
- **实时仪表盘**：展示 XYZE 坐标、喷嘴/热床温度、缓冲区状态、速度倍率、流量倍率和预计剩余时间 (ETA)。

#### 5. 多色与渲染模式
- **颜色模式**：支持单色、Z 轴渐变、彩虹模式和多色模式。
- **多色响应**：自动响应 `T0-T3` 换刀指令和 `M600` 换料指令，动态更新渲染流。

---

## Next Phase: Node.js Bridge & ESM Extraction
The current single-file version will be split into:
1. `sim/core.js`: Shared ESM module for G-code parsing and kinematic planning.
2. `server.js`: Zero-dependency Node.js server providing a raw TCP (8888) interface to mimic ESP3D, plus an HTTP/SSE server to push state to the frontend.
3. `index.html`: Pure frontend renderer receiving data via Server-Sent Events.
