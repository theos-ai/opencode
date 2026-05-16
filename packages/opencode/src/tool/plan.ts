import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

export const Parameters = Schema.Struct({})

export const PLAN_EXIT_METADATA_KIND = "plan_exit"
export const IMPLEMENT_PLAN_OPTION = "Implement plan"
export const REFINE_PLAN_OPTION = "No, and tell Theos what to do differently"

export type PlanExitMetadata = {
  kind: typeof PLAN_EXIT_METADATA_KIND
  planPath: string
  planMarkdown: string
  approved?: boolean
  answer?: string[]
}

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const filesystem = yield* AppFileSystem.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const absolutePlanPath = Session.plan(info, instance)
          const plan = path.relative(instance.worktree, absolutePlanPath)
          const planMarkdown =
            (yield* filesystem.readFileStringSafe(absolutePlanPath).pipe(Effect.orElseSucceed(() => undefined))) ?? ""
          const metadata: PlanExitMetadata = {
            kind: PLAN_EXIT_METADATA_KIND,
            planPath: plan,
            planMarkdown,
          }

          yield* ctx.metadata({
            title: "Plan ready for approval",
            metadata,
          })

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: "Implement this plan?",
                header: "Plan",
                custom: true,
                options: [
                  { label: IMPLEMENT_PLAN_OPTION, description: "Switch to build mode and implement the plan" },
                  { label: REFINE_PLAN_OPTION, description: "Stay in plan mode and describe what should change" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const answer = answers[0] ?? []
          if (answer[0] !== IMPLEMENT_PLAN_OPTION) {
            return {
              title: "Plan needs changes",
              output: answer.length
                ? `User requested plan changes:\n${answer.join("\n")}`
                : "User requested plan changes.",
              metadata: {
                ...metadata,
                approved: false,
                answer,
              },
            }
          }

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: IMPLEMENT_PLAN_OPTION,
          } satisfies MessageV2.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Continue in build mode and implement the approved plan.",
            metadata: {
              ...metadata,
              approved: true,
              answer,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
