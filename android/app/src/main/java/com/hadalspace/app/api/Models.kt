package com.hadalspace.app.api

import kotlinx.serialization.Serializable
import java.time.Instant

/** A task as returned by `GET /api/tasks` (backend `models/task.rs`). */
@Serializable
data class TaskItem(
    val id: Int,
    val taskNumber: Int? = null,
    val name: String,
    val description: String = "",
    /** 1 = Highest … 5 = Lowest. */
    val priority: Int = 3,
    /** A task-status slug. */
    val status: String,
    val assignedBy: String = "",
    val assignee: String = "",
    val assigneeId: Int? = null,
    val projectId: Int? = null,
    @Serializable(with = ServerInstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(with = ServerInstantSerializer::class) val updatedAt: Instant? = null,
)

/**
 * Body of `POST /api/tasks` and `PUT /api/tasks/{id}`. PUT is a full replace,
 * so an edit always starts from the existing task ([from]) and carries over
 * fields this app doesn't show, such as the assignee.
 */
@Serializable
data class TaskInput(
    val name: String = "",
    val description: String = "",
    val priority: Int = 3,
    val status: String? = null,
    val assignedBy: String = "",
    val assignee: String = "",
    val assigneeId: Int? = null,
    val projectId: Int? = null,
) {
    companion object {
        fun from(task: TaskItem) = TaskInput(
            name = task.name,
            description = task.description,
            priority = task.priority,
            status = task.status,
            assignedBy = task.assignedBy,
            assignee = task.assignee,
            assigneeId = task.assigneeId,
            projectId = task.projectId,
        )
    }
}

/** `GET /api/task-statuses` (backend `tasks/statuses.rs`). */
@Serializable
data class TaskStatus(
    val id: Int,
    val slug: String,
    val name: String,
    val description: String? = null,
    val color: String? = null,
    /** backlog | planned | in_progress | completed | canceled */
    val category: String,
    val position: Int? = null,
) {
    /** Completed and canceled statuses count as finished, as on the web. */
    val isFinished: Boolean get() = category == "completed" || category == "canceled"
}

/** `GET /api/projects`. */
@Serializable
data class Project(val id: Int, val name: String)

/** The parts of `GET /api/me` the app uses. */
@Serializable
data class Me(
    /** Picks this user's slot in multi-recipient envelopes. */
    val id: Int? = null,
    val email: String,
    val username: String? = null,
    val accountType: String? = null,
    /** "personal", "organization" or "platform"; older servers leave it out. */
    val scope: String? = null,
    val currentPlan: Plan? = null,
    /** The role in that scope ("owner" … "guest"). */
    val effectiveRole: String? = null,
) {
    @Serializable
    data class Plan(val tier: String? = null)

    /** The scope, falling back to the account type as the web does. */
    val resolvedScope: String?
        get() = scope ?: when (accountType) {
            "personal" -> "personal"
            "organization", "organization_admin" -> "organization"
            "platform_admin" -> "platform"
            else -> null
        }
}

object Priority {
    val all = listOf(1, 2, 3, 4, 5)

    fun label(priority: Int): String = when (priority) {
        1 -> "Highest"
        2 -> "High"
        3 -> "Medium"
        4 -> "Low"
        else -> "Lowest"
    }
}
