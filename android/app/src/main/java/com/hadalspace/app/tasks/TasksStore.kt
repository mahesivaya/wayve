package com.hadalspace.app.tasks

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hadalspace.app.api.ApiClient
import com.hadalspace.app.api.ApiError
import com.hadalspace.app.api.Project
import com.hadalspace.app.api.TaskInput
import com.hadalspace.app.api.TaskItem
import com.hadalspace.app.api.TaskStatus
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * The boards that share the task shape and screens. Only [Tasks] is wired up
 * in the app so far; stories and tickets reuse everything here later.
 */
enum class Board(val path: String, val noun: String, val plural: String) {
    Tasks("/api/tasks", "task", "tasks"),
    Stories("/api/user-stories", "user story", "user stories"),
    Tickets("/api/workspace-tickets", "ticket", "tickets");

    /** "Task", for the start of a sentence: "Task #12". */
    val title: String get() = noun.replaceFirstChar { it.uppercase() }
}

/**
 * Loads and edits a board's items. Plain class (no Android types) so it's unit
 * tested on the JVM; the screen holds it in a ViewModel. Mirrors
 * `ios/Fluxze/Tasks/TasksStore.swift`.
 */
class TasksStore(private val api: ApiClient, val board: Board = Board.Tasks) {
    var tasks: List<TaskItem> by mutableStateOf(emptyList())
        private set
    var statuses: List<TaskStatus> by mutableStateOf(emptyList())
        private set
    var projects: List<Project> by mutableStateOf(emptyList())
        private set
    var isLoading: Boolean by mutableStateOf(false)
        private set
    var hasLoaded: Boolean by mutableStateOf(false)
        private set
    var errorMessage: String? by mutableStateOf(null)

    suspend fun load() {
        isLoading = true
        try {
            coroutineScope {
                val statusList = async { api.get<List<TaskStatus>>("/api/task-statuses") }
                val taskList = async { api.get<List<TaskItem>>(board.path) }
                // Projects only label tasks; a failure there shouldn't hide them.
                val projectList = async { runCatching { api.get<List<Project>>("/api/projects") }.getOrNull() }
                statuses = statusList.await().sortedBy { it.position ?: 0 }
                tasks = taskList.await()
                projectList.await()?.let { projects = it }
            }
            errorMessage = null
        } catch (e: ApiError.Unauthorized) {
            // AppState signs out.
        } catch (e: ApiError) {
            errorMessage = e.message
        } finally {
            isLoading = false
            hasLoaded = true
        }
    }

    fun status(slug: String): TaskStatus? = statuses.firstOrNull { it.slug == slug }

    fun project(id: Int?): Project? = id?.let { pid -> projects.firstOrNull { it.id == pid } }

    fun isFinished(task: TaskItem): Boolean = status(task.status)?.isFinished ?: false

    /** The first "completed" status, used for the quick complete action. */
    val completedStatus: TaskStatus? get() = statuses.firstOrNull { it.category == "completed" }

    suspend fun create(input: TaskInput) {
        val created: TaskItem = api.post(board.path, input)
        tasks = tasks + created
    }

    suspend fun update(task: TaskItem, input: TaskInput) {
        val updated: TaskItem = api.put("${board.path}/${task.id}", input)
        replace(updated)
    }

    /** Moves a task to another status straight away, and puts it back if the server refuses. */
    suspend fun setStatus(task: TaskItem, slug: String) {
        if (task.status == slug) return
        val input = TaskInput.from(task).copy(status = slug)
        replace(task.copy(status = slug))
        try {
            val updated: TaskItem = api.put("${board.path}/${task.id}", input)
            replace(updated)
        } catch (e: ApiError) {
            replace(task)
            errorMessage = e.message
        }
    }

    /** Removes a task straight away, and puts it back if the server refuses. */
    suspend fun delete(task: TaskItem) {
        val index = tasks.indexOfFirst { it.id == task.id }
        if (index < 0) return
        tasks = tasks.filterNot { it.id == task.id }
        try {
            api.delete("${board.path}/${task.id}")
        } catch (e: ApiError) {
            tasks = tasks.toMutableList().apply { add(minOf(index, size), task) }
            errorMessage = e.message
        }
    }

    private fun replace(task: TaskItem) {
        tasks = tasks.map { if (it.id == task.id) task else it }
    }
}
