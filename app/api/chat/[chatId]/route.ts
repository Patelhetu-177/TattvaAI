import { LangChainStream } from "ai"; // Ensure this is the correct import
import { currentUser } from "@clerk/nextjs/server";
import { Replicate } from "@langchain/community/llms/replicate";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { NextResponse } from "next/server";

import { MemoryManager } from "@/lib/memory";
import { rateLimit } from "@/lib/rate-limit";
import prismadb from "@/lib/prismadb";

export async function POST(
  request: Request,
  { params }: { params: { chatId: string } }
) {
  try {
    const { prompt } = await request.json(); // Corrected destructuring
    console.log(`prompt: `, prompt);
    console.log(typeof prompt); // Will log the type of prompt

    const user = await currentUser();

    if (!user || !user.firstName || !user.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const identifier = request.url + "-" + user.id;
    const { success } = await rateLimit(identifier);

    if (!success) {
      return new NextResponse("rateLimit exceeded", { status: 429 });
    }

    // Ensure `prompt` is valid before proceeding
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return new NextResponse("Invalid prompt", { status: 400 });
    }

    const companion = await prismadb.companion.update({
      where: {
        id: params.chatId,
      },
      data: {
        messages: {
          create: {
            content: prompt,
            role: "user",
            userId: user.id,
          },
        },
      },
    });

    if (!companion) {
      return new NextResponse("Companion not found", { status: 404 });
    }

    const name = companion.id;
    const companion_file_name = name + ".txt";

    const companionKey = {
      companionName: name,
      userId: user.id,
      modelName: "llama2-13b",
    };

    const memoryManager = await MemoryManager.getInstance();

    const records = await memoryManager.readLatestHistory(companionKey);
    if (records.length === 0) {
      await memoryManager.seedChatHistory(companion.seed, "\n\n", companionKey);
    }
    await memoryManager.writeToHistory("User: " + prompt + "\n", companionKey);

    const recentChatHistory = await memoryManager.readLatestHistory(
      companionKey
    );

    const similarDocs = await memoryManager.vectorSearch(
      recentChatHistory,
      companion_file_name
    );
    let relevantHistory = "";
    if (!!similarDocs && similarDocs.length !== 0) {
      relevantHistory = similarDocs.map((doc) => doc.pageContent).join("\n");
    }

    const { stream, writer } = LangChainStream();

    const model = new Replicate({
      model:
        "a16z-infra/llama-2-13b-chat:df7690f1994d94e96ad9d568eac121aecf50684a0b0963b25a41cc40061269e5",
      input: { max_length: 2048 },
      apiKey: process.env.REPLICATE_API_TOKEN,
      callbackManager: CallbackManager.fromHandlers({
        // handleLLMNewToken: (token) => writer.write(token),
        // handleLLMStart: () => {},
        // handleLLMEnd: () => writer.close(),
        // handleLLMError: () => writer.close(),

        handleLLMNewToken: (token) => writer.write(token),
        // handleLLMStart: (_llm, _prompts) => {},
        // handleLLMEnd: (_output) => writer.close(),
        // handleLLMError: () => writer.close(),
      }),
    });

    model.verbose = true;

    const resp = String(
      await model.invoke(`
          ONLY generate plain sentences without prefix of who is speaking. DO NOT use ${companion.name}: prefix.

          ${companion.instruction}

          Below are relevant details about ${companion.name}'s past and the conversation you are in.
          ${relevantHistory}

          ${recentChatHistory}\n${companion.name}:
        `)
    );

    const cleaned = resp.replaceAll(",", "");
    const chunks = cleaned.split("\n");
    const response = chunks[0];

    await memoryManager.writeToHistory("" + response.trim(), companionKey);

    if (response && response.length > 1) {
      await prismadb.companion.update({
        where: { id: params.chatId },
        data: {
          messages: {
            create: {
              content: response.trim(),
              role: "system",
              userId: user.id,
            },
          },
        },
      });
    }

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    console.log("[CHAT_POST]", error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
