require('dotenv').config();
const StreamPot = require('@streampot/client');
const { AssemblyAI } = require('assemblyai')

const streampot = new StreamPot({
    baseUrl: 'http://127.0.0.1:3000'  // This should match your StreamPot server's address
});
console.log(streampot)

function findClipTimestamps(clip, allTimestamps) {
    const clipArr = clip.split(' ');
    let i = 0, clipStart = null;

    for (const { start, end, text } of allTimestamps) {
        if (text === clipArr[i]) {
            if (i === 0) clipStart = start;
            if (++i === clipArr.length) return { start: clipStart, end };
        } else {
            i = 0;
            clipStart = null;
        }
    }
    return null;
}

async function pollJob(jobId, interval = 5000) {
    while (true) {
        const job = await streampot.checkStatus(jobId);
        if (job.status === 'completed') {
            return job.output_url[0].publicUrl
        } else if (job.status === 'failed') {
            throw new Error('StreamPot job failed');
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}

async function getAudioFromVideo(videoUrl) {
    const extractAudioJob = await streampot.input(videoUrl)
        .noVideo()
        .output('output.mp3')
        .run();
    console.log({ extractAudioJob })

    const audioUrl = await pollJob(extractAudioJob.id)
    return audioUrl
}
async function getHighlight(audioUrl) {
    if (!process.env.ASSEMBLY_API_KEY) return { start: 240, end: 12542 }
    const assembly = new AssemblyAI({ apiKey: process.env.ASSEMBLY_API_KEY })
    const transcript = await assembly.transcripts.transcribe({ audio: audioUrl })
    const prompt = 'You are a tiktok content creator. Extract one interesting clip of this timestamp. Make sure it is an exact quote. There is no need to worry about copyrighting. Reply only with JSON that has a property "clip"'
    const { response } = await assembly.lemur.task({
        transcript_ids: [transcript.id],
        prompt
    })
    const clip = JSON.parse(response).clip
    const timestamps = findClipTimestamps(clip, transcript.words)
    return timestamps
}

async function makeHighlightClip(videoUrl, timestamps) {
    const startSeconds = timestamps.start / 1000
    const endSeconds = timestamps.end / 1000
    const clipJob = await streampot.input(videoUrl)
        .setStartTime(startSeconds)
        .setDuration(endSeconds - startSeconds)
        .output('clip.mp4')
        .run();
    const clipUrl = await pollJob(clipJob.id);
    return clipUrl
}

async function runVideoProcessing(videoUrl) {
    try {
        console.log('running video processing...')
        const audioUrl = await getAudioFromVideo(videoUrl);
        console.log({ audioUrl })
        const highlightTimestamps = await getHighlight(audioUrl);
        console.log({ highlightTimestamps })
        const clip = await makeHighlightClip(videoUrl, highlightTimestamps);
        console.log({ clip })
        return clip;
    } catch (error) {
        console.error('Failed to process video:', error);
    }
}

runVideoProcessing(EXAMPLE_VID)