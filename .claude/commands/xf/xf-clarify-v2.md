---
description: 独立 v2 需求澄清：将场景、业务规则和疑点转为需求与异常验收例
---

# xf-clarify-v2：需求澄清

命令版本 2.2.0。与 xf-brainstorm-v2 是替代入口；已有合格探索稿时不要求重复澄清。

## 用户输入

```text
$ARGUMENTS
```

## 共同约定

执行前读取 `.opencode/command-resources/product-split-v2/` 下的 `downstream.md`、`downstream-templates.md`、`downstream-checklist.md` 和 `eventstorming.md`。

只写 `xspec/xf/v2/requirements.md`、`requirements-review.md`、`feedback.md`，遵守共同约定。不建立正式 change、FR/AC 或门禁记录。

## 执行

1. 读取独立 PRODUCT、split-review、实际需求来源、已有探索与反馈。确认本轮包含/排除的 SCN / CAP / BR；区分用户决定、会议摘要、现状和建议。
2. 沿事件过程澄清业务语义，区分意图、观测、承诺、受理和完成。对疑点先查现有材料，只有缺失业务信息且会改变结论时提出问题；不依赖答案的部分继续完成。
3. 将范围内能力写为 REQ，保留来源及业务规则。把关键正常、拒绝、并发、超时/迟到、取消或恢复情形写为 EX，明确前提、触发、可观察结果和责任方。
4. 检查已有模块能否承接规则和异常；发现不符写 feedback 回到 split。澄清过程中不以建表或选聚合代替业务问题，不在此冻结实现。
5. 形成设计交接，说明已知权威事实、需设计验证的边界假设、业务问题对方案的影响及保守行为。关键未知不能被“默认同意”消除。
6. 按模板生成 requirements，重新读盘执行 R01–R06、G01–G06，报告记录来源和产物摘要及可承接范围。

## 完成报告

提供需求与报告链接，说明需求/验收范围、已解决与仍未确认的问题、设计输入和自检结果。文档完成不表示业务审批或设计通过。
