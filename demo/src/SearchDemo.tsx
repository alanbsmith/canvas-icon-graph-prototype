import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Flex, Box } from '@workday/canvas-kit-react/layout';
import { InputGroup } from '@workday/canvas-kit-react/text-input';
import { SystemIcon } from '@workday/canvas-kit-react/icon';
import { Card } from '@workday/canvas-kit-react/card';
import { Heading, Text, Subtext } from '@workday/canvas-kit-react/text';
import { searchIcon } from '@workday/canvas-system-icons-web';

import { searchIconsByNaturalLanguage, iconImageUrl } from './api';
import type { IconSearchResult } from './types';

// A few queries that don't share exact words with the icons they should
// find -- good ones to have ready during a live demo, since they're
// exactly the kind of query today's keyword-only search struggles with.
const EXAMPLE_QUERIES = [
  'something for canceling an action',
  'icon to show someone’s identity or profile',
  'a way to indicate audio is off',
];

export function SearchDemo() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IconSearchResult[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [hasSearched, setHasSearched] = useState(false);

  async function runSearch(searchQuery: string) {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;

    setStatus('loading');
    setHasSearched(true);
    try {
      const searchResults = await searchIconsByNaturalLanguage(trimmed);
      setResults(searchResults);
      setStatus('idle');
    } catch (error) {
      console.error(error);
      setStatus('error');
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      runSearch(query);
    }
  }

  return (
    <Flex flexDirection="column" alignItems="center" width="100%" maxWidth={960} gap={24}>
      <Box width="100%" maxWidth={560}>
        <InputGroup>
          <InputGroup.InnerStart as={SystemIcon} pointerEvents="none" icon={searchIcon} />
          <InputGroup.Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the icon you're looking for..."
            width="100%"
            autoComplete="off"
          />
        </InputGroup>
      </Box>

      <Flex gap={8} flexWrap="wrap" justifyContent="center">
        {EXAMPLE_QUERIES.map((example) => (
          <Text
            key={example}
            as="button"
            typeLevel="subtext.large"
            variant="hint"
            onClick={() => {
              setQuery(example);
              runSearch(example);
            }}
            style={{ cursor: 'pointer', border: 'none', background: 'none', textDecoration: 'underline', padding: 0 }}
          >
            "{example}"
          </Text>
        ))}
      </Flex>

      {status === 'loading' && <Text>Searching...</Text>}
      {status === 'error' && (
        <Text variant="error">
          Search failed -- is the search server running? (`npm run search-server` in the project root)
        </Text>
      )}

      {hasSearched && status === 'idle' && results.length === 0 && <Text>No results found.</Text>}

      <Flex flexWrap="wrap" gap={16} justifyContent="center">
        {results.map((result) => (
          <Card key={result.name} width={200}>
            <Card.Body>
              <Flex flexDirection="column" alignItems="center" gap={8}>
                <img
                  src={iconImageUrl(result.name)}
                  alt={result.figmaName}
                  width={64}
                  height={64}
                  style={{ objectFit: 'contain' }}
                />
                <Heading size="small" as="h3">
                  {result.figmaName}
                </Heading>
                <Subtext size="medium" variant="hint">
                  {result.category}
                </Subtext>
                <Text typeLevel="subtext.medium" style={{ textAlign: 'center' }}>
                  {result.shortDescription}
                </Text>
              </Flex>
            </Card.Body>
          </Card>
        ))}
      </Flex>
    </Flex>
  );
}
