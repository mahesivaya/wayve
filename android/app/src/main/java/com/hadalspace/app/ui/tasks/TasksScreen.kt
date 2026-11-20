package com.hadalspace.app.ui.tasks

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import com.hadalspace.app.api.ApiClient
import com.hadalspace.app.api.Priority
import com.hadalspace.app.api.Project
import com.hadalspace.app.api.TaskItem
import com.hadalspace.app.api.TaskStatus
import com.hadalspace.app.tasks.Board
import com.hadalspace.app.tasks.TasksStore
import kotlinx.coroutines.launch

/** Holds the store across rotation and while Settings is open. */
class TasksViewModel(api: ApiClient, board: Board) : ViewModel() {
    val store = TasksStore(api, board)
}

/** What the editor is showing: nothing, a new task, or an existing one. */
private sealed interface Editing {
    data object New : Editing
    data class Existing(val task: TaskItem) : Editing
}

/** The Tasks list. Mirrors `ios/Fluxze/Views/TaskListView.swift`. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    api: ApiClient,
    sessionKey: String,
    onOpenSettings: () -> Unit,
    board: Board = Board.Tasks,
) {
    val vm: TasksViewModel = viewModel(key = "${board.name}:$sessionKey") { TasksViewModel(api, board) }
    val store = vm.store
    val scope = rememberCoroutineScope()

    var search by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var statusFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var priorityFilter by rememberSaveable { mutableStateOf<Int?>(null) }
    var showCompleted by rememberSaveable { mutableStateOf(false) }
    var filterMenuOpen by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Editing?>(null) }
    var pendingDelete by remember { mutableStateOf<TaskItem?>(null) }

    LaunchedEffect(store) { if (!store.hasLoaded) store.load() }

    // The editor replaces the list while open; back closes it.
    editing?.let { current ->
        BackHandler { editing = null }
        TaskEditScreen(
            store = store,
            task = (current as? Editing.Existing)?.task,
            onClose = { editing = null },
        )
        return
    }

    val isFiltering = statusFilter != null || priorityFilter != null || search.isNotBlank()
    val filtered = store.tasks.filter { task ->
        val query = search.trim().lowercase()
        (statusFilter == null || task.status == statusFilter) &&
            (priorityFilter == null || task.priority == priorityFilter) &&
            (query.isEmpty() || task.name.lowercase().contains(query) || task.description.lowercase().contains(query))
    }
    val active = filtered.filterNot(store::isFinished)
    val done = filtered.filter(store::isFinished)

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (searching) {
                        TextField(
                            value = search,
                            onValueChange = { search = it },
                            placeholder = { Text("Search ${board.plural}") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Text(board.plural.replaceFirstChar { it.uppercase() })
                    }
                },
                actions = {
                    IconButton(onClick = {
                        if (searching) search = ""
                        searching = !searching
                    }) {
                        Icon(
                            if (searching) Icons.Default.Close else Icons.Default.Search,
                            contentDescription = if (searching) "Close search" else "Search",
                        )
                    }
                    Box {
                        IconButton(onClick = { filterMenuOpen = true }) {
                            Icon(
                                Icons.Default.FilterList,
                                contentDescription = "Filter",
                                tint = if (statusFilter != null || priorityFilter != null) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.onSurface
                                },
                            )
                        }
                        FilterMenu(
                            expanded = filterMenuOpen,
                            statuses = store.statuses,
                            statusFilter = statusFilter,
                            priorityFilter = priorityFilter,
                            onStatus = { statusFilter = it },
                            onPriority = { priorityFilter = it },
                            onDismiss = { filterMenuOpen = false },
                        )
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.AccountCircle, contentDescription = "Account")
                    }
                },
            )
        },
        floatingActionButton = {
            if (store.statuses.isNotEmpty()) {
                FloatingActionButton(onClick = { editing = Editing.New }) {
                    Icon(Icons.Default.Add, contentDescription = "New ${board.noun}")
                }
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = store.isLoading && store.hasLoaded,
            onRefresh = { scope.launch { store.load() } },
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                !store.hasLoaded -> Centered { CircularProgressIndicator() }

                store.tasks.isEmpty() && store.errorMessage != null -> Centered {
                    Text("Couldn't load ${board.plural}", style = MaterialTheme.typography.titleMedium)
                    Text(store.errorMessage.orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = { scope.launch { store.load() } }) { Text("Try again") }
                }

                store.tasks.isEmpty() -> Centered {
                    Text("No ${board.plural} yet", style = MaterialTheme.typography.titleMedium)
                    Text("Tap + to add your first ${board.noun}.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }

                else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                    item { SectionHeader("Active (${active.size})") }
                    if (active.isEmpty()) {
                        item {
                            Text(
                                if (isFiltering) "No matching ${board.plural}" else "Nothing left to do",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                            )
                        }
                    }
                    items(active, key = { it.id }) { task ->
                        TaskRowWithMenu(store, task, onEdit = { editing = Editing.Existing(task) }, onDelete = { pendingDelete = task })
                    }
                    if (done.isNotEmpty()) {
                        item {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { showCompleted = !showCompleted }
                                    .padding(horizontal = 16.dp, vertical = 12.dp),
                            ) {
                                Text("Completed (${done.size})", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                                Icon(if (showCompleted) Icons.Default.ExpandLess else Icons.Default.ExpandMore, contentDescription = null)
                            }
                        }
                        if (showCompleted) {
                            items(done, key = { it.id }) { task ->
                                TaskRowWithMenu(store, task, onEdit = { editing = Editing.Existing(task) }, onDelete = { pendingDelete = task })
                            }
                        }
                    }
                }
            }
        }
    }

    pendingDelete?.let { task ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete this ${board.noun}?") },
            text = { Text(task.name) },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    scope.launch { store.delete(task) }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Cancel") } },
        )
    }

    // A failed status change or delete, once the list is showing.
    val error = store.errorMessage
    if (error != null && store.hasLoaded && store.tasks.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = { store.errorMessage = null },
            title = { Text("Something went wrong") },
            text = { Text(error) },
            confirmButton = { TextButton(onClick = { store.errorMessage = null }) { Text("OK") } },
        )
    }
}

@Composable
private fun FilterMenu(
    expanded: Boolean,
    statuses: List<TaskStatus>,
    statusFilter: String?,
    priorityFilter: Int?,
    onStatus: (String?) -> Unit,
    onPriority: (Int?) -> Unit,
    onDismiss: () -> Unit,
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        MenuLabel("Status")
        CheckItem("All statuses", statusFilter == null) { onStatus(null); onDismiss() }
        statuses.forEach { s -> CheckItem(s.name, statusFilter == s.slug) { onStatus(s.slug); onDismiss() } }
        HorizontalDivider()
        MenuLabel("Priority")
        CheckItem("All priorities", priorityFilter == null) { onPriority(null); onDismiss() }
        Priority.all.forEach { p -> CheckItem(Priority.label(p), priorityFilter == p) { onPriority(p); onDismiss() } }
        if (statusFilter != null || priorityFilter != null) {
            HorizontalDivider()
            DropdownMenuItem(text = { Text("Clear filters") }, onClick = { onStatus(null); onPriority(null); onDismiss() })
        }
    }
}

@Composable
private fun MenuLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun CheckItem(text: String, checked: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(text, fontWeight = if (checked) FontWeight.SemiBold else FontWeight.Normal) },
        onClick = onClick,
        trailingIcon = { if (checked) Icon(Icons.Default.CheckCircle, contentDescription = "Selected", modifier = Modifier.size(18.dp)) },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TaskRowWithMenu(store: TasksStore, task: TaskItem, onEdit: () -> Unit, onDelete: () -> Unit) {
    val scope = rememberCoroutineScope()
    var menuOpen by remember { mutableStateOf(false) }
    var moveOpen by remember { mutableStateOf(false) }
    val finished = store.isFinished(task)
    val completed = store.completedStatus

    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onEdit, onLongClick = { menuOpen = true })
                .padding(horizontal = 8.dp, vertical = 6.dp),
        ) {
            // Tap the circle to complete, as the iOS leading swipe does.
            IconButton(
                onClick = { if (!finished && completed != null) scope.launch { store.setStatus(task, completed.slug) } },
                enabled = !finished && completed != null,
            ) {
                Icon(
                    if (finished) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked,
                    contentDescription = if (finished) "Done" else "Mark done",
                    tint = if (finished) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TaskRow(task, store.status(task.status), store.project(task.projectId), finished, Modifier.weight(1f))
        }

        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false; moveOpen = false }) {
            if (!moveOpen) {
                DropdownMenuItem(text = { Text("Move to…") }, onClick = { moveOpen = true })
                DropdownMenuItem(text = { Text("Edit") }, onClick = { menuOpen = false; onEdit() })
                DropdownMenuItem(
                    text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                    onClick = { menuOpen = false; onDelete() },
                )
            } else {
                store.statuses.forEach { s ->
                    DropdownMenuItem(
                        text = { Text(s.name) },
                        enabled = s.slug != task.status,
                        onClick = {
                            menuOpen = false
                            moveOpen = false
                            scope.launch { store.setStatus(task, s.slug) }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: TaskItem, status: TaskStatus?, project: Project?, finished: Boolean, modifier: Modifier = Modifier) {
    Column(modifier = modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            task.name,
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textDecoration = if (finished) TextDecoration.LineThrough else null,
            color = if (finished) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            status?.let { StatusChip(it) }
            Text(Priority.label(task.priority), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            project?.let {
                Text(it.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            task.taskNumber?.let {
                Spacer(Modifier.weight(1f))
                Text("#$it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun StatusChip(status: TaskStatus) {
    val color = parseHexColor(status.color) ?: MaterialTheme.colorScheme.secondary
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier
            .background(color.copy(alpha = 0.15f), RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(status.name, style = MaterialTheme.typography.labelSmall)
    }
}

/** `#RRGGBB` or `#RGB` from the status settings; null when unreadable. */
internal fun parseHexColor(hex: String?): Color? {
    val raw = hex?.trim()?.removePrefix("#") ?: return null
    val full = when (raw.length) {
        3 -> raw.map { "$it$it" }.joinToString("")
        6 -> raw
        else -> return null
    }
    val value = full.toLongOrNull(16) ?: return null
    return Color(0xFF000000 or value)
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
    ) { content() }
}
