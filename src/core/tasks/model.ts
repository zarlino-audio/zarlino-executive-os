/**
 * Task model — factory for creating internal Task records with sane defaults.
 */
import type { Priority, Task, TaskStatus } from "../../types";
import { newId, nowIso } from "../../ids";

export interface CreateTaskInput {
  title: string;
  description?: string;
  project_id?: string;
  decision_id?: string;
  assignee_person_id?: string;
  priority?: Priority | string;
  status?: TaskStatus | string;
  due_date?: string;
  success_condition?: string;
  source?: string;
}

export function createTask(input: CreateTaskInput): Task {
  const now = nowIso();
  const priority = input.priority ?? "P2";
  return {
    id: newId("tsk"),
    title: input.title.trim(),
    description: input.description?.trim() ?? undefined,
    project_id: input.project_id,
    decision_id: input.decision_id,
    assignee_person_id: input.assignee_person_id,
    status: input.status ?? "OPEN",
    priority,
    due_date: input.due_date,
    success_condition: input.success_condition,
    source: input.source ?? "executive",
    auto_run: 1,
    created_at: now,
    updated_at: now,
  };
}
