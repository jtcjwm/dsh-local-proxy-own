# 第三方组件声明

本包（dsh-local-proxy-own）自身以 MIT 许可发布，**但包内含有一份第三方可执行文件**，
它遵循自己的许可证，不受本项目 MIT 许可覆盖。

## sing-box（GPL-3.0-or-later）

| 项 | 内容 |
|---|---|
| 文件 | bin/sing-box.exe |
| 说明 | sing-box 的 Windows amd64 构建，**未做任何修改**，仅原样随包分发 |
| 上游 | https://github.com/SagerNet/sing-box |
| 许可 | GNU General Public License v3.0 or later（GPL-3.0-or-later） |
| 构建信息 | go1.24.7 windows/amd64 · revision 7f2316aff0cc0c1a200f3fae192b064865b3c97e · tags with_utls,with_quic,with_clash_api |
| 源码获取 | 上游仓库对应 revision；GPL 要求的分发义务由上游与本包共同满足 |

### 对你的影响

- 如果你只是**安装并使用**本插件：无需任何额外动作。
- 如果你是**再分发**本包（例如打包进你自己的发行版）：bin/sing-box.exe 那部分仍受 GPL-3.0 约束，
  你需要一并提供对应源码或书面指向上游仓库，并保留本声明。
- 本插件自身的 JavaScript 代码（src/、bin/*.js、scripts/）与 sing-box 无链接关系，
  不因分发该二进制而被传染为 GPL。

## 其他

- React 等运行时依赖由 DeepSeek Harness 宿主提供，不随本包分发。
- 本包**不包含任何代理节点配置**（节点属于用户自有凭据，安装后由用户自行配置）。
