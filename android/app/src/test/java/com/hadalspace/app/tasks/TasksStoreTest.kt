package com.hadalspace.app.tasks

import com.hadalspace.app.api.ApiClient
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TasksStoreTest {
    private lateinit var server: MockWebServer
    private lateinit var store: TasksStore

    /** Responses by "METHOD path"; anything else is a 404. */
    private val routes = mutableMapOf<String, MockResponse>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                routes["${request.method} ${request.path}"] ?: MockResponse().setResponseCode(404)
        }
        server.start()
        store = TasksStore(ApiClient(server.url("/").toString(), token = "t"))
        routes["GET /api/task-statuses"] = json(
            """[{"id":2,"slug":"done","name":"Done","category":"completed","position":2},
               {"id":1,"slug":"todo","name":"To do","category":"planned","position":1}]"""
        )
        routes["GET /api/tasks"] = json(
            """[{"id":10,"name":"Write tests","status":"todo","priority":2},
               {"id":11,"name":"Old","status":"done"}]"""
        )
        routes["GET /api/projects"] = json("""[{"id":5,"name":"Hadal"}]""")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun json(body: String) = MockResponse().setBody(body)

    @Test
    fun loadsSortsStatusesAndSplitsFinishedTasks() = runTest {
        store.load()
        assertTrue(store.hasLoaded)
        assertNull(store.errorMessage)
        assertEquals(listOf("todo", "done"), store.statuses.map { it.slug })
        assertEquals(listOf(10, 11), store.tasks.map { it.id })
        assertFalse(store.isFinished(store.tasks[0]))
        assertTrue(store.isFinished(store.tasks[1]))
        assertEquals("Hadal", store.project(5)?.name)
        assertEquals("done", store.completedStatus?.slug)
    }

    @Test
    fun aProjectsFailureStillShowsTasks() = runTest {
        routes["GET /api/projects"] = MockResponse().setResponseCode(500)
        store.load()
        assertNull(store.errorMessage)
        assertEquals(2, store.tasks.size)
        assertTrue(store.projects.isEmpty())
    }

    @Test
    fun aFailedLoadShowsAnError() = runTest {
        routes["GET /api/tasks"] = MockResponse().setResponseCode(500)
        store.load()
        assertTrue(store.hasLoaded)
        assertEquals("Something went wrong on the server. Please try again.", store.errorMessage)
    }

    @Test
    fun aStatusChangeTheServerRefusesIsPutBack() = runTest {
        store.load()
        routes["PUT /api/tasks/10"] = MockResponse().setResponseCode(400).setBody("""{"message":"Not allowed"}""")
        store.setStatus(store.tasks[0], "done")
        assertEquals("todo", store.tasks.first { it.id == 10 }.status)
        assertEquals("Not allowed", store.errorMessage)
    }

    @Test
    fun aStatusChangeSendsTheWholeTask() = runTest {
        store.load()
        routes["PUT /api/tasks/10"] = json("""{"id":10,"name":"Write tests","status":"done","priority":2}""")
        store.setStatus(store.tasks[0], "done")
        assertEquals("done", store.tasks.first { it.id == 10 }.status)

        val put = generateSequence { server.takeRequest() }.first { it.method == "PUT" }
        val body = put.body.readUtf8()
        assertTrue(body, body.contains("\"name\":\"Write tests\"") && body.contains("\"priority\":2"))
    }

    @Test
    fun aDeleteTheServerRefusesIsPutBackInPlace() = runTest {
        store.load()
        routes["DELETE /api/tasks/10"] = MockResponse().setResponseCode(403).setBody("""{"message":"Nope"}""")
        store.delete(store.tasks[0])
        assertEquals(listOf(10, 11), store.tasks.map { it.id })
        assertEquals("Nope", store.errorMessage)
    }

    @Test
    fun createAppendsTheNewTask() = runTest {
        store.load()
        routes["POST /api/tasks"] = json("""{"id":12,"name":"New","status":"todo"}""")
        store.create(com.hadalspace.app.api.TaskInput(name = "New", status = "todo"))
        assertEquals(listOf(10, 11, 12), store.tasks.map { it.id })
    }
}
