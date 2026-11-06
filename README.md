# Star Simulation (3D Printer Simulator)

## English

### Project Overview
This repository contains a high-precision 3D printer simulator, evolving from a pure single-file SPA prototype (Phase 1) to a production-ready Software-in-the-Loop (SIL) testing platform (Phase 2). 

It acts as a drop-in replacement for physical hardware (e.g., Anet A8 + ESP3D). Host software (like Python-based G-code senders or LLM agents) can interface with this simulator via raw TCP to verify command parsing, kinematic behavior, and thermal physics.

### Architecture Evolution

#### Phase 1: Monolithic Baseline
Originally encapsulated entirely within a single `index.html`, running purely in the browser. It proved the core rendering and simulation logic using Three.js and Vanilla JS.

#### Phase 2: Node.js Bridge & Decoupled Architecture
To support raw TCP communication for host software, the architecture is now split into a backend service and a web frontend.

[ Host Software / Python Scripts ]
       │ (Raw TCP: 8888)
       ▼
[ Node.js Backend (server.js) ] <--- Firmware & Network Layer
       │      │
       │      └─> [ sim/core.js ] (Shared ESM: Parser & State Machine)
       │ (SSE / HTTP POST: 3001)
       ▼
[ Web Frontend (index.html) ] <--- 3D Renderer & UI

1. **Node.js Backend (`server.js`)**: The single source of truth. Listens on TCP port `8888` to emulate real hardware, and hosts an HTTP server on port `3001` for the frontend.
2. **Shared Core (`sim/core.js`)**: Pure ESM logic containing the G-code tokenizer and firmware state machine (handles thermal physics, coordinates, blocking waits).
3. **Web Frontend (`index.html`)**: Receives state and G-code via Server-Sent Events (SSE). It acts as a pure renderer and forwards manual UI interactions back to the backend for synchronized execution.

---

### Key Features & Design

#### 1. Firmware Flow Control (Marlin Emulation)
- **Ring Buffer Simulation**: Simulates the 16-slot command buffer. Supports blocking semantics (`M109`/`M190` will halt the queue until temperature is stable).
- **Command Cancellation**: Supports `M108` to skip temperature waits, and `M112` for emergency stops.
- **State Machine**: Full support for absolute/relative positioning (`G90`/`G91`), extrusion modes (`M82`/`M83`), and unit scaling.
- **Diagnostics**: Real-time responses to `M105` (temps), `M114` (coords), `M119` (dynamic endstops based on coordinates), and `M503`.

#### 2. Kinematics & Planner
- **Interpolation**: Linear moves (`G0`/`G1`) and circular arcs (`G2`/`G3` with I/J or R parameters).
- **Trapezoidal Acceleration**: Calculates speed based on Junction Deviation and axis acceleration limits.
- **Soft Endstops**: Prevents movement out of bounds by clamping coordinates (X/Y/Z).
- **Pure E-Axis Filtering**: Distinguishes true layer changes from pure extruder movements to avoid false layer counting.

#### 3. Thermal Dynamics & Physics
- **PID Control**: Simulates hotend and heated bed temperature curves.
- **Thermal Runaway**: Auto-shuts down the heater if temperature fails to rise within a set time.
- **Ooze Control (Stringing)**: Renders realistic hotend ooze trails during non-extruding travel moves, with distance-based fade-out.
- **Retraction**: Simulates `G10`/`G11` and `M207`, properly accounting for negative E-axis movements without rendering them as extrusion lines.

#### 4. UI/UX & Visualization
- **Layer Clipping**: Uses WebGL Clipping Planes to slice the model visually along the Z-axis via a slider.
- **Density Histogram**: The progress bar features a white density block layout representing the execution density, overlaid with a semi-transparent blue progress fill.
- **Code Highlighter**: A synchronized editor showing line numbers and highlighting the executing G-code.
- **Interactive CLI**: A built-in terminal to send manual G-codes. It syncs with the Node.js backend, ensuring the TCP host and the web UI are always consistent.
- **Dashboard**: Real-time telemetry including XYZE coordinates, temperatures, buffer status, speed/flow factors, and ETA.

#### 5. Multi-Color & Rendering
- **Color Modes**: Single color, Z-gradient, Rainbow, and Multi-color.
- **Multi-color Support**: Reacts to `T0-T3` tool changes and `M600` filament swaps, updating the visual rendering stream dynamically.

---

### Quick Start
1. Start the Node.js bridge:
   `node server.js`
2. Open the 3D dashboard:
   `http://localhost:3001`
3. Connect your host software to `tcp://localhost:8888`. Both the web UI and the host script will now operate in perfect synchronization.

---

## 中文

### 项目概述
本仓库包含了一个高精度 3D 打印机仿真器。它从纯单文件 SPA 原型（阶段一）演进为一个生产级的软件在环（SIL）测试平台（阶段二）。

它可以作为真实硬件（如 Anet A8 + ESP3D）的完美平替。上位机软件（如 Python 编写的脚本或 LLM Agent）可以通过原生 TCP 连接此仿真器，以验证 G-code 解析、运动学行为及热力学模型，而无需物理打印机。

### 架构演进

#### 阶段一：单体基线
最初所有功能完整封装在一个 `index.html` 文件中，纯浏览器运行。它基于 Three.js 和原生 JS 验证了核心的渲染与物理仿真逻辑。

#### 阶段二：Node.js 桥接与前后端分离
为了支持上位机的原生 TCP 通信，现在架构已拆分为后端服务与前端页面。

[ 上位机脚本 / Python 代码 ]
       │ (原生 TCP: 8888)
       ▼
[ Node.js 后端 (server.js) ] <--- 固件与网络协议层
       │      │
       │      └─> [ sim/core.js ] (共享核心：G-code 解析与状态机)
       │ (SSE 推送 / HTTP POST 接口: 3001)
       ▼
[ 浏览器前端 (index.html) ] <--- 3D 渲染与 UI 仪表盘

1. **Node.js 后端 (`server.js`)**：全系统唯一的“真理源”。监听 TCP `8888` 端口模拟真实硬件；同时启动 HTTP 服务监听 `3001` 端口托管前端。
2. **共享核心 (`sim/core.js`)**：纯 ESM 模块。包含词法解析器和固件状态机，负责热力学、坐标计算和阻塞指令（如 M109）。
3. **浏览器前端 (`index.html`)**：通过 Server-Sent Events (SSE) 接收状态和 G-code 指令，只作为纯粹的渲染器。手动操作的指令会提交给后端统一执行。

---

### 核心功能与设计

#### 1. 固件流控与状态机 (Marlin 仿真)
- **环形缓冲区模拟**：模拟 16 槽指令缓冲区。支持阻塞语义（`M109`/`M190` 会挂起队列，直到温度稳定）。
- **指令干预**：支持 `M108` 跳过温度等待，支持 `M112` 紧急停机。
- **状态机**：完整支持绝对/相对定位（`G90`/`G91`）、挤出模式（`M82`/`M83`）和单位换算。
- **状态查询**：实时响应 `M105`（温度）、`M114`（坐标）、`M119`（基于真实坐标动态判断限位）、`M503` 等指令。

#### 2. 运动学与轨迹规划
- **插补算法**：直线（`G0`/`G1`）和圆弧插补（`G2`/`G3`）。
- **梯形加减速**：基于 Junction Deviation 和轴加速度限制计算速度。
- **软限位**：实时限制并截断超出打印体积的指令。
- **纯 E 轴过滤**：在计算模型层数时，正确区分真实的 Z 轴抬升和纯挤出动作，防止层数误判。

#### 3. 热力学与物理仿真
- **PID 温控**：模拟喷嘴和热床的温度曲线。
- **热失控保护**：加热器全功率输出但温度异常时自动切断并报警。
- **拉丝/漏料特效 (Ooze)**：在高温空驶移动时，渲染逼真的漏料拉丝轨迹，并在一定距离内逐渐变淡。
- **回抽模拟**：支持 `G10`/`G11` 及 `M207`，正确扣除 E 轴负向移动，且不会将回抽渲染为挤出线。

#### 4. UI 交互与可视化
- **分层剖切预览**：通过 WebGL 裁剪平面 (Clipping Plane) 和滑块，沿 Z 轴剖切模型。
- **指令密度直方图**：进度条底层使用纯白块显示 G-code 执行密度，表层覆盖蓝色进度和黑色层分割线。
- **代码高亮追踪**：带有行号的同步编辑器，并高亮当前执行行。
- **交互式终端**：内置 CLI。与 Node.js 后端实时同步，确保网页操作和外部 TCP 操作的一致性。
- **实时仪表盘**：展示 XYZE 坐标、温度、缓冲区状态、速度/流量倍率及预计剩余时间。

#### 5. 多色与渲染模式
- **颜色模式**：支持单色、Z 轴渐变、彩虹模式和多色模式。
- **多色响应**：自动响应 `T0-T3` 换刀指令和 `M600` 换料指令，动态更新渲染流。

---

### 快速开始
1. 启动 Node.js 后端服务：
   `node server.js`
2. 在浏览器中打开 3D 仪表盘：
   `http://localhost:3001`
3. 将上位机软件连接至 `tcp://localhost:8888`。此时，网页 UI 与上位机脚本将实现完美的实时双向同步。