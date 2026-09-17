package output

// Profile 描述一次扫描属于哪个产品（网关侧 leakscan / 端上 leakagent），
// 决定报告措辞与统计口径。两个产品共用同一套识别规则（EBR-006），
// 但报告面向的读者、能拿到的字段完全不同：网关报告面向安全团队，
// 谈的是"员工""部门""网关"；端上报告面向开发者自己，这些词在
// 端上语境里要么无意义、要么直接失实（开发者自己电脑上没有"员工姓名"）。
//
// Profile 只是数据，不含行为：writeSummary 按 Profile 里的字段决定
// 打印什么文案、渲染哪些章节，网关侧的分支必须与改动前逐字一致
// （见 profile_test.go 的 TestGatewayReportUnchanged）。
type Profile struct {
	ID string // "gateway" | "endpoint"，仅用于标识/调试，不直接进报告正文

	ReportTitle     string // 报告一级标题
	SensitivityNote string // 标题下的敏感性提示（完整句子）

	// SubjectNoun 是发现聚合的主体称谓，只用于不带量词的位置（表头、短语），
	// 如"涉及员工"→"涉及会话"。带量词的整句（"涉及 %d 名员工或 Key"）
	// 量词不同（"名" vs "个"），不能靠替换这个名词拼出来，见下面两个专用字段。
	SubjectNoun string

	// CoverageNote 是"## 1. 检测覆盖"开头的说明句，必须保留
	// "没有发现 ≠ 没有泄漏"（EBR-009，PRODUCT §2.3 两个产品都要求）。
	CoverageNote string

	// FileModeNote 是 st.Source != "" 时（非数据库扫描：网关侧的本地文件扫描、
	// 端上的会话扫描）打印的一段说明，两个产品含义完全不同，不能靠替换名词拼出来。
	FileModeNote string

	// ShowSystemIssues 控制"## 2. 系统性问题：网关自身保存了调用方凭证"整节
	// 是否渲染。该节依赖请求头/认证头统计，只对网关产品有意义；
	// 端上永远不渲染这节（TestEndpointCoverageHidesGatewayFields 护住这点）。
	ShowSystemIssues bool

	// SubjectCountLabel 是"总览"里"涉及 %d %s"的单位短语，
	// 如"名员工或 Key"（网关）/ "个会话"（端上）——量词不同，必须整体替换。
	SubjectCountLabel string

	// RoleSectionNote 是"凭证从哪里出去的（来源角色）"一节里对 user_input
	// 来源的说明句（谁会主动粘贴），网关是"员工"，端上是"你自己"。
	RoleSectionNote string

	// ShowDBSections 控制"按部门"与"客户端（User-Agent）"两节是否渲染
	// （与既有的 st.Source == "" 条件相与）。这两节依赖网关数据库扫描才有的
	// 部门归属和 User-Agent 采集，端上没有，恒为 false。
	ShowDBSections bool

	// ShowDeptColumn 控制"高危发现"表是否渲染"部门"列。端上的 Finding
	// 从不携带部门信息（detect.Record 里端上产品不填 DeptName），
	// 渲染一个恒为空的列没有意义，直接去掉整列而不是留空。
	ShowDeptColumn bool

	// CoverageGapLabels 把 Coverage 里"缺口"字段名映射为该产品报告里的
	// 列标题；不在这个 map 里的字段不渲染——这是隐藏另一产品专有字段
	// （网关的 AuthHeader/NoContentLogOff、端上的 AgentUnsupported 等）的机制。
	// 渲染顺序由 coverageGapFields（report.go）固定，不依赖 map 的遍历顺序
	// （Go map 遍历顺序随机，不能拿来决定列序，否则网关的黄金文件测试会偶发失败）。
	CoverageGapLabels map[string]string
}

const (
	gatewayProfileID  = "gateway"
	endpointProfileID = "endpoint"
)

// GatewayProfile 是网关产品（leakscan）的报告措辞：保持改动前逐字不变。
func GatewayProfile() Profile {
	return Profile{
		ID:                gatewayProfileID,
		ReportTitle:       "网关凭证泄漏回溯审计报告",
		SensitivityNote:   "本文件含员工姓名和凭证脱敏片段，属于敏感数据：仅限安全团队查看，不得提交到代码仓库或转发。",
		SubjectNoun:       "员工",
		CoverageNote:      "**没有发现 ≠ 没有泄漏。** 只有网关实际保存了内容的调用才能被检测。",
		FileModeNote:      "\n文件扫描：每行视为一次调用的请求体，文件中没有员工、部门、客户端和时间信息，发现按\"文件 × 凭证\"汇总，\"调用次数\"为出现该凭证的行数。\n\n",
		ShowSystemIssues:  true,
		SubjectCountLabel: "名员工或 Key",
		RoleSectionNote:   "\"工具结果\"表示编码 agent 读取文件或执行命令后自动带出，整改重点是 agent 的读取范围；\"用户输入\"表示员工主动粘贴。",
		ShowDBSections:    true,
		ShowDeptColumn:    true,
		CoverageGapLabels: nil, // 网关侧的覆盖表是原有的固定表格，不走 GapLabels 通用渲染
	}
}

// EndpointProfile 是端上产品（leakagent）的报告措辞（PRODUCT §2.3）。
func EndpointProfile() Profile {
	return Profile{
		ID:                endpointProfileID,
		ReportTitle:       "本机 Agent 凭证泄漏自查报告",
		SensitivityNote:   "本文件含凭证脱敏片段和本机路径，属于敏感数据：不要提交到代码仓库或放共享盘。",
		SubjectNoun:       "会话",
		CoverageNote:      "**没有发现 ≠ 没有泄漏。** 只有 agent 实际写到磁盘的会话才能被检测；已被 agent 轮转或清理的看不到。",
		FileModeNote:      "\n本机会话：每行是会话文件中的一条记录，发现按\"会话 × 凭证\"汇总，\"调用次数\"为出现该凭证的行数。\n\n",
		ShowSystemIssues:  false,
		SubjectCountLabel: "个会话",
		RoleSectionNote:   "\"工具结果\"表示编码 agent 读取文件或执行命令后自动带出，整改重点是 agent 的读取范围；\"用户输入\"表示你自己主动粘贴。",
		ShowDBSections:    false,
		ShowDeptColumn:    false,
		CoverageGapLabels: map[string]string{
			"RequestParseFail":  "请求内容解析失败",
			"ResponseParseFail": "响应内容解析失败",
			"Oversize":          "超过大小上限未扫描",
			"AgentUnsupported":  "Agent 不支持",
			"ParseFailed":       "会话行格式无法解析",
			"FileVanished":      "文件读取时已消失",
		},
	}
}
