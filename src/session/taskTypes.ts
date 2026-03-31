import { z } from "zod";

export type TaskPhase =
  | "planning"
  | "awaiting-input"
  | "awaiting-approval"
  | "executing";

export interface PendingTaskPlan {
  title: string;
  summary: string;
  tasks: string[];
  tests: string[];
  risks: string[];
  assumptions: string[];
}

export interface TaskModeState {
  phase: TaskPhase;
  pendingPlan?: PendingTaskPlan | undefined;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  header: string;
  id: string;
  question: string;
  options: UserInputOption[];
}

export interface UserInputRequest {
  questions: UserInputQuestion[];
}

export interface UserInputAnswer {
  id: string;
  question: string;
  selectedOption?: UserInputOption | undefined;
  freeformText?: string | undefined;
}

export interface UserInputResult {
  status: "answered" | "cancelled";
  answers: UserInputAnswer[];
  answersById: Record<
    string,
    {
      question: string;
      selectedOption?: UserInputOption | undefined;
      freeformText?: string | undefined;
    }
  >;
}

export interface TaskPlanDecision {
  status: "approved" | "revise" | "cancelled";
  feedback?: string | undefined;
}

export function createTaskModeState(
  phase: TaskPhase = "planning",
): TaskModeState {
  return { phase };
}

export function isTaskPlanningPhase(
  phase: TaskPhase | undefined,
): phase is "planning" | "awaiting-input" | "awaiting-approval" {
  return (
    phase === "planning" ||
    phase === "awaiting-input" ||
    phase === "awaiting-approval"
  );
}

const UserInputOptionSchema = z.object({
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

const UserInputQuestionSchema = z.object({
  header: z.string().trim().min(1),
  id: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z.array(UserInputOptionSchema).min(1),
});

export const UserInputRequestSchema = z.object({
  questions: z.array(UserInputQuestionSchema).min(1).max(3),
});

export const PendingTaskPlanSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  tasks: z.array(z.string().trim().min(1)).min(1),
  tests: z.array(z.string().trim().min(1)).default([]),
  risks: z.array(z.string().trim().min(1)).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([]),
});
