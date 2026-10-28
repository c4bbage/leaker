# leakscan/privacy

高性能、会话级隔离的大模型网关脱敏与还原引擎（Reversible Privacy & Redaction Engine）。

本项目融合了 [yetone/magpie](https://github.com/yetone/magpie) 的协议解析、占位符还原机制、本地 PII 语义模型，以及 `leaker` 原生的国内云与运维高危凭证识别能力。专门以**嵌入式 Go 库**形式提供给 **大模型网关** 使用，无需额外部署 Proxy 进程。

---

## 一、核心架构设计

```
[客户端/Agent] 
       │ 原始请求 (JSON / OpenAI / Anthropic 协议)
       ▼
┌────────────────────────────────────────────────────────┐
│                   大模型网关                    │
│                                                        │
│  1. 开启请求会话: session := protector.NewSession()    │
│  2. 出站前脱敏: maskedReq, err := session.ProtectJSON  │
│     ┌───────────────────────────────────────────────┐  │
│     │            统一识别与脱敏引擎 Pipeline           │  │
│     │  - 静态规则: Magpie PII/Token + Leaker 高危凭证│  │
│     │  - 语义模型: AstrLink Guard (ONNX/CoreML)     │  │
│     │  - 协议感知: 嵌套 JSON/转义 Tool Calls 字段提取  │  │
│     │  - 占位符生成: 会话内独立映射 (内存多租户隔离)  │  │
│     └───────────────────────────────────────────────┘  │
│  3. 将替换为占位符的请求发往大模型                     │
└──────────────────────┬─────────────────────────────────┘
                       │ 脱敏请求 (无任何明文机密)
                       ▼
                 [大模型 Provider]
                 (GPT-4o, Claude, DeepSeek...)
                       │
                       │ 模型响应 (携带稳定占位符)
                       ▼
┌────────────────────────────────────────────────────────┐
│                   大模型网关                    │
│                                                        │
│  4. 响应还原:                                          │
│     - 普通 JSON: session.RestoreJSON(resp)             │
│     - 流式 SSE : writer := session.NewRestoringWriter │
│       (基于状态机自动处理跨 Chunk 切分的占位符还原)   │
│  5. 销毁会话: session.Close() (及时清除内存明文映射)   │
└──────────────────────┬─────────────────────────────────┘
                       │ 还原为原始明文的响应
                       ▼
                 [客户端/Agent]
```

### 关键架构保障
1. **严格的会话级隔离 (Session-Scoped)**：
   - 区别于原 Magpie 进程级的全局变量设计，本包所有映射均在独立的 `Session` 实例中维护，不同用户、不同请求并发互不干扰，用完即销毁，杜绝串号泄露。
2. **零静默放行 (Fail-Closed on Model Failure)**：
   - 当启用模型能力时，如果模型下载中断、哈希校验失败或推理异常，引擎会明确阻断并抛出 `ErrModel`，绝不静默跳过而将明文机密外发。
3. **协议深层感知与容错**：
   - 自动递归解析 OpenAI Tool Calls 参数中“JSON 字符串内部嵌套 JSON”的极端转义场景。
   - 流式 SSE 传输中，若大模型分片把占位符从中间截断（如 chunk1: `{{PHONE_`，chunk2: `1234}}`），流式还原器会自动缓存并拼装还原。

---

## 二、统一规则集与模型覆盖

本包将两套规则完整统一为一个扫描与消除流水线：

| 类别 | 覆盖范围与规则描述 | 来源与处理机制 |
|---|---|---|
| **国内云全量 AK/SK** | 阿里云 (LTAI/STS)、腾讯云 (AKID)、AWS (AKIA/ASIA) | `leaker` 专项注入，**保证成对出现的 ID 与 Secret 均被脱敏替换** |
| **企业高危凭证** | GitLab PAT/Pipeline Token、GitHub Token、Slack/Discord Webhook、数据库连接串、K8s Token | `leaker` + `magpie` 联合匹配 |
| **主机与网络私钥** | OpenSSH 私钥、PuTTY Key、PGP/GPG 私钥、OpenVPN 完整配置、WireGuard 接口 | 支持多行块结构提取与整体替换 |
| **基础 PII (个人信息)** | 手机号 (国内 11 位)、中国大陆二代身份证 (校验码检查)、银行卡 (带 Luhn 算法)、邮箱 (排除 git/noreply 等假数据)、公网 IP、主机名、本地文件敏感路径 | `magpie` 规则库 |
| **国际机密与身份** | SSN (美国社保)、国际护照号、IBAN 国际银行账户、生日等 | `magpie` 规则库 |
| **隐式口令与短语** | 中文/日文/韩文常见赋值上下文（如 `密码是`、`口令为`、`Token:` 等） | `magpie` CJK 语境状态机 |
| **自然语言非结构化实体** | **人名（中文/英文）、家庭/办公物理地址、缺乏固定特征的无前缀机密** | **AstrLink Guard** 本地 INT8 小模型（自动下载校验） |

---

## 三、代码接入与使用方式

### 1. 初始化 Protector (网关级单例)

建议在网关服务启动时初始化一次：

```go
package main

import (
    "log"
    "leakscan/privacy"
)

func initProtector() *privacy.Protector {
    // 默认配置：启用全量规则 + 启用 AstrLink Guard 本地模型（自动按需下载与缓存）
    protector, err := privacy.New(privacy.Config{
        CacheDir: "/var/cache/gateway/models", // 模型持久化目录
    })
    if err != nil {
        log.Fatalf("初始化脱敏引擎失败: %v", err)
    }
    return protector
}
```

> **离线/纯规则模式**：如果部署在完全无公网环境且不需要识别自然语言人名/地址，可声明：
> `privacy.New(privacy.Config{RulesOnly: true})`。

---

### 2. 请求出站前脱敏 (Protect)

在向大模型供应商（OpenAI、Anthropic 等）发出 HTTP 请求前调用：

```go
func handleLLMRequest(ctx context.Context, protector *privacy.Protector, rawReqBody []byte) ([]byte, *privacy.Session, error) {
    // 为当前请求创建独立的 Session
    session := protector.NewSession()

    // 自动适配 JSON 结构（保留 system prompt/model 等字段，只脱敏 user content 和 tool arguments）
    maskedResult, err := session.ProtectJSON(ctx, rawReqBody)
    if err != nil {
        session.Close()
        return nil, nil, err // 阻断或解析异常
    }

    // maskedResult.Body 即为已替换敏感信息的出站请求体
    // maskedResult.Detections 包含了检测到的所有敏感命中项（类型、动作、占位符）
    return maskedResult.Body, session, nil
}
```

---

### 3. 响应接收后还原 (Restore)

必须使用**同一个请求的 `session`** 执行还原。

#### 场景 A：非流式响应 (普通 JSON)

```go
func handleLLMResponse(ctx context.Context, session *privacy.Session, rawRespBody []byte) ([]byte, error) {
    defer session.Close() // 响应还原完成后关闭会话释放明文映射

    // 自动扫描 JSON 字符串中的占位符并还原为原值
    restoredBody, err := session.RestoreJSON(ctx, rawRespBody)
    if err != nil {
        return nil, err
    }
    return restoredBody, nil
}
```

#### 场景 B：流式响应 (SSE / Chunked Transfer)

针对大模型常用的 Server-Sent Events (SSE) 流式返回，使用 `NewRestoringWriter` 包装下游 HTTP ResponseWriter：

```go
func handleLLMStream(session *privacy.Session, upstreamReader io.Reader, clientResponseWriter http.ResponseWriter) error {
    defer session.Close()

    // 包装下游输出流（内置跨 chunk 占位符切分重组状态机）
    restoringWriter := session.NewRestoringWriter(clientResponseWriter)
    defer restoringWriter.Finish() // 确保尾部缓冲的数据刷出

    buf := make([]byte, 4096)
    for {
        n, err := upstreamReader.Read(buf)
        if n > 0 {
            // 写入时会自动完成流式占位符解析与还原
            if _, wErr := restoringWriter.Write(buf[:n]); wErr != nil {
                return wErr
            }
        }
        if err != nil {
            if err == io.EOF {
                break
            }
            return err
        }
    }
    return nil
}
```

---

### 4. 纯文本脱敏与探测接口 (独立 API)

若网关需要提供独立的“敏感信息探测 API”或针对单段文本处理：

```go
session := protector.NewSession()
defer session.Close()

// 仅探测，不改变文本
hits, err := session.Detect(ctx, "测试文本包含手机 13800000000")

// 纯文本脱敏
maskedText, hits, err := session.ProtectText(ctx, "测试文本...")

// 纯文本还原
restoredText, err := session.RestoreText(ctx, maskedText)
```

---

## 四、本地模型规格与下载说明

| 模型名称 | 规格大小 | 默认存储子目录 | 官方 SHA-256 |
|---|---|---|---|
| `model_int8.onnx` | ~330 KB | `astrlink-guard/7216b6a3b897/` | `0a070d3113615e33ba3b84d6bd486f663a377c04c4b056e7381732179f51832a` |
| `model_int8.onnx_data` | ~37 MB | `astrlink-guard/7216b6a3b897/` | `0ba34216ceead01e0ae2dfd8e46d52b67e7aee80b04f722d9b758613a91c0067` |
| `tokenizer.json` | ~1.5 MB | `astrlink-guard/7216b6a3b897/` | `0cf3b235ef125658015a6c8026a5fe6f28088bf825101a990ec18a10200feef4` |

*注：网关初次启动如果无法连接外部 HuggingFace，可直接将上述 3 个文件预先放置在 `CacheDir/astrlink-guard/7216b6a3b897/` 目录下，引擎检测到 SHA-256 吻合即会直接加载离线文件。*
