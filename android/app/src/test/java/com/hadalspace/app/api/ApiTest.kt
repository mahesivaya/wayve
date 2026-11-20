package com.hadalspace.app.api

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant

class ApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        api = ApiClient(server.url("/").toString(), token = "jwt-1")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun sendsTheBearerTokenAndDecodesSnakeCaseTasks() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """[{"id":3,"task_number":12,"name":"Ship","description":"","priority":2,
                   "status":"todo","assigned_by":"me","assignee":"","assignee_id":null,
                   "project_id":7,"created_at":"2026-11-20T10:15:30.123456","extra_field":true}]"""
            )
        )
        val tasks: List<TaskItem> = api.get("/api/tasks")

        val request = server.takeRequest()
        assertEquals("Bearer jwt-1", request.getHeader("Authorization"))
        assertEquals("/api/tasks", request.path)
        val task = tasks.single()
        assertEquals(12, task.taskNumber)
        assertEquals(7, task.projectId)
        assertNull(task.assigneeId)
        assertEquals(Instant.parse("2026-11-20T10:15:30.123456Z"), task.createdAt)
    }

    @Test
    fun encodesTaskInputInSnakeCaseAndLeavesOutAbsentOptionals() = runTest {
        server.enqueue(MockResponse().setBody("""{"id":1,"name":"A","status":"todo"}"""))
        val _created: TaskItem = api.post("/api/tasks", TaskInput(name = "A", status = "todo", projectId = 5))

        val body = server.takeRequest().body.readUtf8()
        assertTrue(body, body.contains("\"project_id\":5"))
        assertTrue(body, body.contains("\"assigned_by\":\"\""))
        assertFalse("null optionals are omitted: $body", body.contains("assignee_id"))
    }

    @Test
    fun a401WithATokenSignsOut() = runTest {
        var signedOut = false
        api.onUnauthorized = { signedOut = true }
        server.enqueue(MockResponse().setResponseCode(401).setBody("unauthorized"))

        val error = runCatching { api.get<Me>("/api/me") }.exceptionOrNull()
        assertTrue(error is ApiError.Unauthorized)
        assertEquals("Your session has expired. Please sign in again.", error!!.message)
        assertTrue(signedOut)
    }

    @Test
    fun a401WithoutATokenDoesNotSignOut() = runTest {
        var signedOut = false
        api.token = null
        api.onUnauthorized = { signedOut = true }
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"message":"Wrong password"}"""))

        val error = runCatching { api.get<Me>("/api/me") }.exceptionOrNull()
        assertEquals("Wrong password", error!!.message)
        assertFalse(signedOut)
    }

    @Test
    fun serverErrorsCarryTheirCodeAndMessage() {
        val e = ApiError.from(403, """{"error":"email_unverified","message":"Verify your email first."}""")
        assertTrue(e is ApiError.Server)
        assertEquals("email_unverified", e.errorCode)
        assertEquals("Verify your email first.", e.message)

        assertEquals("Something went wrong on the server. Please try again.", ApiError.from(502, "<html>").message)
        assertEquals("Too many attempts. Please wait a minute and try again.", ApiError.from(429, "").message)
        assertEquals("Request failed (418).", ApiError.from(418, "").message)
        assertEquals("plain text reason", ApiError.from(400, "plain text reason").message)
    }

    @Test
    fun parsesTheServersDateShapes() {
        assertEquals(Instant.parse("2026-11-20T10:15:30Z"), ServerDate.parse("2026-11-20T10:15:30"))
        assertEquals(Instant.parse("2026-11-20T10:15:30Z"), ServerDate.parse("2026-11-20 10:15:30"))
        assertEquals(Instant.parse("2026-11-20T05:15:30Z"), ServerDate.parse("2026-11-20T10:15:30+05:00"))
        assertEquals(Instant.parse("2026-11-20T10:15:30.5Z"), ServerDate.parse("2026-11-20T10:15:30.5Z"))
        assertNull(ServerDate.parse("yesterday"))
    }

    @Test
    fun meFallsBackToTheAccountTypeForItsScope() {
        val me = ApiJson.decodeFromString(Me.serializer(), """{"email":"a@b.c","account_type":"organization_admin"}""")
        assertEquals("organization", me.resolvedScope)
    }
}
