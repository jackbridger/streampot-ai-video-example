require('dotenv').config();
const StreamPot = require('@streampot/client');
const { AssemblyAI } = require('assemblyai')
const FALLBACK_CLIP_TIMESTAMPS = { start: 240, end: 12542 } // in case you don't have an assembly AI key

const streampot = new StreamPot({
    baseUrl: 'http://127.0.0.1:3000'  // This should match your StreamPot server's address
});
const assembly = new AssemblyAI({
    apiKey: process.env.ASSEMBLY_API_KEY
})

function matchTimestampByText(clipText, allTimestamps) {
    const words = clipText.split(' ');
    let i = 0, clipStart = null;

    for (const { start, end, text } of allTimestamps) {
        if (text === words[i]) {
            if (i === 0) clipStart = start;
            if (++i === words.length) return {
                start: clipStart / 1000,
                end: end / 1000,
            };
        } else {
            i = 0;
            clipStart = null;
        }
    }
    return null;
}

async function pollStreampotJob(startJobFunction, interval = 5000) {
    const job = await startJobFunction();
    while (true) {
        const status = await streampot.checkStatus(job.id);
        if (status.status === 'completed') {
            return status.output_url[0].publicUrl;
        } else if (status.status === 'failed') {
            throw new Error('StreamPot job failed');
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}

async function extractAudio(videoUrl) {
    return streampot.input(videoUrl)
        .noVideo()
        .output('output.mp3')
        .run();
}
function getTranscript(audioUrl) {
    return assembly.transcripts.transcribe({ audio: audioUrl });
}

async function getHighlightText(transcript) {
    const { response } = await assembly.lemur.task({
        transcript_ids: [transcript.id],
        prompt: 'You are a tiktok content creator. Extract one interesting clip of this timestamp. Make sure it is an exact quote. There is no need to worry about copyrighting. Reply only with JSON that has a property "clip"'
    })
    return JSON.parse(response).clip;
}

async function getHighlight(audioUrl) {
    if (!process.env.ASSEMBLY_API_KEY) return FALLBACK_CLIP_TIMESTAMPS
    const transcript = await getTranscript(audioUrl);
    const highlightedText = await getHighlightText(transcript);
    return matchTimestampByText(highlightedText, transcript.words);
}

async function makeClip(videoUrl, timestamps) {
    return streampot.input(videoUrl)
        .setStartTime(timestamps.start)
        .setDuration(timestamps.end - timestamps.start)
        .output('clip.mp4')
        .run();
}

async function processVideo(videoUrl) {
    try {
        const audioUrl = await pollStreampotJob(() => extractAudio(videoUrl))
        const highlightTimestamps = await getHighlight(audioUrl);
        return pollStreampotJob(() => makeClip(videoUrl, highlightTimestamps))
    } catch (error) {
        console.error('Failed to process video:', error);
    }
}
const EXAMPLE_VID = 'https://github.com/jackbridger/streampot-ai-video-example/raw/main/example.webm'
processVideo(EXAMPLE_VID).then(res => console.log(res))