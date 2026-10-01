# Ghost

在 Node.js 宿主进程中嵌入 DeepSeek Harness，运行 Agent、调用本地技能，并将会话事件保存为 JSONL。模型接口统一通过 `dsh-llm-pi-ai` 接入。

## 运行

需要 Node.js 24 或更高版本。

```sh
npm install
cp -n .env.example .env
```

按下文配置 `.env`，然后运行：

```sh
npm start -- "用 greeting 技能跟我打个招呼，我叫 Richard。"
```

程序输出事件、回答、Token 用量和会话日志路径。日志默认保存在 `.dsh-home/sessions/`。模型请求失败时退出码为 `1`。当前入口执行一轮任务后释放 Agent。

## 配置接口和模型

所有模型连接写在 `.env`，添加模型或接口只需编辑这里：

```dotenv
MODEL_PROVIDER=gateway
MODEL_NAME=model-a

MODEL_PROVIDERS='{
  "gateway": {
    "api": "openai-completions",
    "baseURL": "https://gateway.example.com/v1",
    "apiKeyEnv": "GATEWAY_API_KEY",
    "models": [
      { "id": "model-a", "maxTokens": 4096 },
      { "id": "model-b", "maxTokens": 8192 }
    ]
  }
}'

GATEWAY_API_KEY=你的密钥
```

`MODEL_PROVIDERS` 是用单引号包裹的 JSON 对象，可以换行。对象的键是你自定义的 provider 名称。`MODEL_PROVIDER` 选择初始接口，`MODEL_NAME` 选择该接口 `models` 中的模型 ID。示例中的地址和 ID 需要替换为服务实际提供的值。

同一个地址、协议和密钥提供的模型放在同一个 `models` 列表中。不同接口在 `MODEL_PROVIDERS` 中新增一个键，各自定义 `api`、`baseURL`、`apiKeyEnv` 和 `models`；所有配置的接口会同时注册。`.env.example` 包含两个接口的完整示例。

| api | 协议 | baseURL 示例 |
| --- | --- | --- |
| `openai-completions` | Chat Completions | `https://api.openai.com/v1` |
| `openai-responses` | Responses | `https://api.openai.com/v1` |
| `anthropic-messages` | Anthropic Messages | `https://api.anthropic.com` |

地址填写 API 根路径，不包含 `/chat/completions`、`/responses` 或 `/messages`。网关需要兼容所选协议的流式响应和工具调用。

`apiKeyEnv` 填写保存密钥的环境变量名称，密钥本身写在该变量中。启动时检查选中接口的密钥；调用其他接口时由适配器解析其密钥。

每个模型可以配置 `maxTokens`（默认输出上限）、`contextWindow`（上下文容量）、`input`（如 `["text", "image"]`），以及适配器支持的 `reasoningEfforts`、`compat` 等字段。每个接口也可配置 `headers`、`compat`、`timeoutMs` 等原生 pi-ai 适配器字段。配置在启动时读取，编辑后重新启动。

## 同一 Agent 中切换模型

宿主可在 Agent 创建后安装模型选择器，保留同一会话历史：

```ts
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'

const selection: ModelSelectionRef = {
  current: { provider, model },
  assembled: undefined,
}
installModelSelection(agent.ctx, selection)

await agent.whenIdle()
selection.current = { provider: 'gateway', model: 'model-b' }
// 然后通过 agent.followup(...) 继续对话。
```

切换目标必须出现在 `MODEL_PROVIDERS` 中。更换接口时同时替换 provider 和 model；选择器在后续步骤生效，正在进行的请求保持原选择。
