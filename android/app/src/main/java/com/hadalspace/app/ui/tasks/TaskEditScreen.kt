package com.hadalspace.app.ui.tasks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.hadalspace.app.api.Priority
import com.hadalspace.app.api.TaskInput
import com.hadalspace.app.api.TaskItem
import com.hadalspace.app.tasks.TasksStore
import kotlinx.coroutines.launch
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Create (`task == null`) or edit a task. Mirrors `ios/Fluxze/Views/TaskEditView.swift`. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskEditScreen(store: TasksStore, task: TaskItem?, onClose: () -> Unit) {
    val board = store.board
    var input by remember(task?.id) {
        mutableStateOf(task?.let(TaskInput::from) ?: TaskInput(status = store.statuses.firstOrNull()?.slug))
    }
    var isSaving by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val canSave = input.name.isNotBlank() && !isSaving
    val title = when {
        task == null -> "New ${board.noun}"
        task.taskNumber != null -> "${board.title} #${task.taskNumber}"
        else -> "Edit ${board.noun}"
    }

    fun save() {
        isSaving = true
        errorMessage = null
        val body = input.copy(name = input.name.trim())
        scope.launch {
            try {
                if (task != null) store.update(task, body) else store.create(body)
                onClose()
            } catch (e: Exception) {
                errorMessage = e.message
            } finally {
                isSaving = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onClose, enabled = !isSaving) {
                        Icon(Icons.Default.Close, contentDescription = "Cancel")
                    }
                },
                actions = {
                    if (isSaving) {
                        CircularProgressIndicator(modifier = Modifier.padding(end = 16.dp).size(20.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(onClick = { save() }, enabled = canSave) { Text("Save") }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            OutlinedTextField(
                value = input.name,
                onValueChange = { input = input.copy(name = it) },
                label = { Text("${board.title} name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = input.description,
                onValueChange = { input = input.copy(description = it) },
                label = { Text("Description") },
                minLines = 3,
                maxLines = 10,
                modifier = Modifier.fillMaxWidth(),
            )

            Picker(
                label = "Status",
                selected = store.statuses.firstOrNull { it.slug == input.status }?.name ?: "—",
                options = store.statuses.map { it.name to it.slug },
                onSelect = { slug -> input = input.copy(status = slug) },
            )
            Picker(
                label = "Priority",
                selected = Priority.label(input.priority),
                options = Priority.all.map { Priority.label(it) to it },
                onSelect = { p -> input = input.copy(priority = p) },
            )
            if (store.projects.isNotEmpty()) {
                Picker(
                    label = "Project",
                    selected = store.project(input.projectId)?.name ?: "None",
                    options = listOf("None" to null) + store.projects.map { it.name to it.id },
                    onSelect = { id -> input = input.copy(projectId = id) },
                )
            }

            if (task != null && (task.assignee.isNotEmpty() || task.assignedBy.isNotEmpty())) {
                HorizontalDivider()
                if (task.assignee.isNotEmpty()) Detail("Assignee", task.assignee)
                if (task.assignedBy.isNotEmpty()) Detail("Assigned by", task.assignedBy)
            }

            task?.createdAt?.let { created ->
                HorizontalDivider()
                Detail("Created", formatInstant(created))
                task.updatedAt?.let { Detail("Updated", formatInstant(it)) }
            }

            errorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }

            if (task != null) {
                HorizontalDivider()
                TextButton(onClick = { confirmDelete = true }, enabled = !isSaving) {
                    Text("Delete ${board.noun}", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }

    if (confirmDelete && task != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete this ${board.noun}?") },
            text = { Text(task.name) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    scope.launch { store.delete(task) }
                    onClose()
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

/** A labelled button that opens a menu of [options] (label to value). */
@Composable
private fun <T> Picker(label: String, selected: String, options: List<Pair<String, T>>, onSelect: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Text(selected, modifier = Modifier.weight(1f))
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { (name, value) ->
                    DropdownMenuItem(text = { Text(name) }, onClick = {
                        open = false
                        onSelect(value)
                    })
                }
            }
        }
    }
}

@Composable
private fun Detail(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value)
    }
}

private val dateTimeFormat: DateTimeFormatter =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)

private fun formatInstant(instant: java.time.Instant): String =
    dateTimeFormat.format(instant.atZone(ZoneId.systemDefault()))
