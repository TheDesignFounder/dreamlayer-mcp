import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagedClient, isVideoPrompt } from "../dist/client.js";
import { downloadVideo } from "../dist/video.js";

test("video intent does not hijack image or sprite requests", () => {
  assert.equal(isVideoPrompt("Create a video game character"), false);
  assert.equal(isVideoPrompt("Make a poster for a video"), false);
  assert.equal(isVideoPrompt("Create a sprite sheet from video"), false);
  assert.equal(isVideoPrompt("Turn this image into a video"), true);
  assert.equal(isVideoPrompt("Make a 15-second video"), true);
});
import { callTool } from "../dist/tools.js";

test("MCP video tools preserve authorization and structured recovery identity", async (t) => {
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async (url,init)=>{
    calls++;
    if(String(url).endsWith("/quotes")) return Response.json({status:"ready",quote_id:"quote",selected_model:"flux-3"});
    assert.equal(init.headers.get("Idempotency-Key"),"saved-key");
    throw new TypeError("lost receipt");
  };
  const client=new ManagedClient("fixture","http://127.0.0.1:8090");
  const quoted=await callTool(client,"dreamlayer_video_quote",{prompt:"video"});
  assert.equal(quoted.structuredContent.selected_model,"flux-3");
  const executed=await callTool(client,"dreamlayer_video_execute",{quote_id:"quote",max_credits:30,idempotency_key:"saved-key"});
  assert.equal(executed.isError,true);
  assert.equal(executed.structuredContent.error.idempotency_key,"saved-key");
  assert.equal(calls,2);
});

test("video quote and execution keep ceiling/key, never auto-retry an uncertain POST", async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (url, init) => {
    calls.push({url: String(url), init, body: JSON.parse(init.body)});
    if (String(url).endsWith("/quotes")) return Response.json({status: "ready", quote_id: "quote", selected_model: "seedance-2.5"});
    throw new TypeError("simulated response loss");
  };
  const client = new ManagedClient("fixture", "http://127.0.0.1:8090");
  const quote = await client.quoteVideo({prompt: "Make a video", options: {duration_seconds: 25}});
  assert.equal(quote.selected_model, "seedance-2.5");
  await assert.rejects(client.executeVideo("quote", 40, "stable-key"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, {quote_id: "quote", max_credits: 40});
  assert.equal(calls[1].init.headers.get("Idempotency-Key"), "stable-key");
  for (const cap of [0, -1, NaN, Infinity, 101]) await assert.rejects(client.executeVideo("quote", cap, "key"));
  assert.equal(calls.length, 2);
});

test("ordinary video prompt requests a quote without spend authorization", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.get("DreamLayer-Features"), "video-quotes-v1");
    assert.equal(init.headers.get("DreamLayer-Version"), "1");
    assert.deepEqual(JSON.parse(init.body), {prompt: "Make a 15-second video", input_asset_id: "asset"});
    return Response.json({status: "quote_required", quote: {quote_id: "quote"}});
  };
  const result = await new ManagedClient("fixture", "http://127.0.0.1:8090").planVideoPrompt("Make a 15-second video", "asset");
  assert.equal(result.status, "quote_required");
});

test("owned video download streams, checks hash, never forwards key or overwrites", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  const dir = await mkdtemp(path.join(tmpdir(), "dreamlayer-video-test-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const payload = Buffer.from("video fixture");
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/asset")) return new Response(null, {status: 302, headers: {Location: "https://storage.googleapis.com/fixture/result.mp4?signature=fixture"}});
    if (String(url).startsWith("https://storage.googleapis.com/")) {
      assert.equal(init.headers, undefined);
      assert.equal(init.redirect, "error");
      return new Response(payload);
    }
    return Response.json({status: "completed", video_job: {metadata: {bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex")}}});
  };
  const client = new ManagedClient("fixture", "http://127.0.0.1:8090");
  const target = path.join(dir, "video.mp4");
  assert.equal(await downloadVideo(client, "execution", target), payload.length);
  assert.deepEqual(await readFile(target), payload);
  await assert.rejects(downloadVideo(client, "execution", target), /Destination exists/);
  assert.deepEqual(await readdir(dir), ["video.mp4"]);
  assert.equal(calls.filter(url => url.endsWith("/asset")).length, 1);
});

test("video redirect refuses arbitrary hosts and checksum failure leaves no file", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  const client = new ManagedClient("fixture", "http://127.0.0.1:8090");
  globalThis.fetch = async () => new Response(null, {status: 302, headers: {Location: "https://evil.example/result.mp4"}});
  await assert.rejects(client.videoDownloadResponse("execution"), /Unapproved/);
  const dir = await mkdtemp(path.join(tmpdir(), "dreamlayer-video-test-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/asset")) return new Response(null, {status: 302, headers: {Location: "https://storage.googleapis.com/fixture/result.mp4"}});
    if (String(url).startsWith("https://storage.googleapis.com/")) return new Response("bad");
    return Response.json({status: "completed", video_job: {metadata: {bytes: 3, sha256: "0".repeat(64)}}});
  };
  await assert.rejects(downloadVideo(client, "execution", path.join(dir, "video.mp4")), /checksum/);
  assert.deepEqual(await readdir(dir), []);
});
