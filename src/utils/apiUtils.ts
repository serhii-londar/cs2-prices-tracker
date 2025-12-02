import SteamCommunity from "steamcommunity";
import * as colors from 'colors';

const itemsBaseUrl = "https://api.cs2data.gg/en"; // CS2 DATA API
const marketBaseURL = "https://steamcommunity.com/market";

// Retry configuration constants
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

/**
 * Helper function to retry async operations with exponential backoff
 */
async function fetchWithRetry<T>(
    operation: () => Promise<T>,
    retries: number = MAX_RETRIES,
    delay: number = RETRY_DELAY_MS,
    operationName: string = "operation"
): Promise<T> {
    let lastError: any;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            
            if (attempt < retries) {
                const waitTime = delay * Math.pow(2, attempt); // Exponential backoff
                console.log(colors.yellow(`Retry ${attempt + 1}/${retries} for ${operationName} after ${waitTime}ms...`));
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
    
    throw lastError;
}

export async function getAllItemNames(): Promise<string[]> {
    const endpoints = [
        "skins_not_grouped.json",
        "stickers.json",
        "crates.json",
        "agents.json",
        "keys.json",
        "patches.json",
        "graffiti.json",
        "music_kits.json",
        "collectibles.json",
        "keychains.json"
    ];

    const allItems: string[] = [];
    
    // Fetch each endpoint individually with retry logic
    for (const endpoint of endpoints) {
        try {
            const items = await fetchWithRetry(
                async () => {
                    const response = await fetch(`${itemsBaseUrl}/${endpoint}`);
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    return response.json();
                },
                MAX_RETRIES,
                RETRY_DELAY_MS,
                `fetch ${endpoint}`
            );
            
            const itemNames = items
                .filter(Boolean)
                .map((item: any) => item.market_hash_name);
            
            allItems.push(...itemNames);
        } catch (error) {
            console.log(colors.red(`Failed to fetch ${endpoint} after ${MAX_RETRIES} retries: ${error}`));
            // Continue with other endpoints even if one fails
        }
    }
    
    return allItems;
}

export async function fetchPrice(community: SteamCommunity, name: string): Promise<any[]> {
    return fetchWithRetry(
        () => new Promise<any[]>((resolve, reject) => {
            community.httpRequestGet(
                `${marketBaseURL}/pricehistory/?appid=730&market_hash_name=${encodeURIComponent(name)}`,
                (err: Error | null, res: any, body: string) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    try {
                        // Handle rate limiting
                        if (res.statusCode === 429) {
                            console.log(colors.yellow(`Rate limit (429) for ${name}, will retry...`));
                            reject(new Error(`Rate limit (429) for ${name}`));
                            return;
                        }
                        
                        // Handle other non-200 status codes
                        if (res.statusCode !== 200) {
                            console.log(colors.yellow(`HTTP ${res.statusCode} for ${name}, will retry...`));
                            reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
                            return;
                        }

                        const prices = (JSON.parse(body).prices || []).map(
                            ([time, value, volume]: [string, number, string]) => ({
                                time: Date.parse(time),
                                value,
                                volume: parseInt(volume),
                            })
                        );
                        resolve(prices);
                    } catch (parseError) {
                        reject(parseError);
                    }
                }
            );
        }),
        MAX_RETRIES,
        RETRY_DELAY_MS,
        `fetchPrice for ${name}`
    ).catch(error => {
        console.log(colors.red(`Failed to fetch price for ${name} after ${MAX_RETRIES} retries: ${error.message}`));
        return []; // Return empty array only after all retries are exhausted
    });
}
