---
description: 独立 v2 需求探索：通过业务事件、分歧和方案取舍形成可交接的需求稿
---

# xf-brainstorm-v2：需求探索

命令版本 2.2.0。与 xf-clarify-v2 是替代入口，不要求依次执行。

## 用户输入

```text
$ARGUMENTS
```

## 共同约定

执行前读取 `.opencode/command-resources/product-split-v2/` 下的 `downstream.md`、`downstream-templates.md`、`downstream-checklist.md` 和 `eventstorming.md`，遵守其独立范围、证据与反馈约定。

只写 `xspec/xf/v2/exploration.md`、`exploration-review.md`、`feedback.md`。不运行正式节点或修改正式制品。

## 执行

1. 读取独立 PRODUCT、split-review、相关来源和既有 feedback。圈定探索的 SCN / CAP / BR，说明问题来自用户目标、业务分歧还是方案约束。
2. 用业务事件讲清当前/建议过程，再补角色、命令、决策信息和反应规则。按相关性保留并行、异常和 Hot Spots，不编造会议共识。
3. 有实质取舍才比较方案，说明对业务价值、所有权、规则、成本和现有系统的影响。已有决定直接承接；尚未决定的方案标建议与影响，不机械要求用户再次确认。
4. 发现产品范围或拆分前提不成立时写 feedback，给可复核反例与受影响 ID。本命令不静默重划 PRODUCT 边界。
5. 若本稿将直接交接 design，补齐 REQ、EX 的前提/动作/结果、来源、规则、确认程度和设计输入，并执行 R01–R06。无法明确的关键需求保留问题，相关设计不可承接。
6. 按模板写 exploration，重新读盘检查 B01–B04、适用的 R01–R06 及 G01–G06；报告记录产物和上游 SHA-256。

## 完成报告

说明探索范围、选择及其依据、未解决的问题、文档自检和向 design 可交接范围；提供文件链接。只有想法清单时明确不可直接进入设计。正式流程未推进。
